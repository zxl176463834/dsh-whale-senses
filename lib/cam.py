#!/usr/bin/env python
"""dsh-whale-senses — camera sidecar.

Called by the plugin host over argv, prints one JSON object on stdout.
Subcommands:
  list                  enumerate cameras (name from WinRT + working opencv index)
  info --device N       read current values of the adjustable properties
  snap --device N ...   grab one frame and write it to --out
  caps --device N       report which properties the device actually accepts
  range --device N      authoritative min/max/step/default + current value, via WinRT
  set --device N ...    write adjustable properties, via WinRT

两条底层通道，各干各擅长的事：
  * OpenCV / DirectShow —— 抓帧。稳、快，但 get/set 读数不准（gain 读成 248、
    focus 恒 0），只能用来「大概动一下」。
  * WinRT MediaCapture —— 读/写 UVC 参数。caps 是驱动直接汇报的
    min/max/step/default，写入后 OpenCV 抓出来的帧立刻跟着变（已实测）。
    代价是要单独打开一次设备，且拿不到 saturation / sharpness / gain
    （这三个不走 VideoDeviceController，只能退回 OpenCV）。

Everything is best-effort: a camera that rejects a property just reports
"unsupported" instead of failing the whole call.
"""
import argparse
import asyncio
import json
import os
import sys

# 先把 OpenCV 的日志压下去，再 import cv2（顺序不能反）
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
os.environ.setdefault("OPENCV_VIDEOIO_DEBUG", "0")
os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", "0")

import cv2

# OpenCV -> friendly property name. Keep in sync with the client panel.
PROPS = {
    "brightness": cv2.CAP_PROP_BRIGHTNESS,
    "contrast": cv2.CAP_PROP_CONTRAST,
    "saturation": cv2.CAP_PROP_SATURATION,
    "hue": cv2.CAP_PROP_HUE,
    "gain": cv2.CAP_PROP_GAIN,
    "exposure": cv2.CAP_PROP_EXPOSURE,
    "sharpness": cv2.CAP_PROP_SHARPNESS,
    "gamma": cv2.CAP_PROP_GAMMA,
    "wb_temperature": cv2.CAP_PROP_WB_TEMPERATURE,
    "focus": cv2.CAP_PROP_FOCUS,
}

# 面板上的名字 -> VideoDeviceController 上的属性名。
# 注意 WinRT 这层没有 saturation / sharpness / gain，它们只能走 OpenCV。
WINRT_MAP = {
    "brightness": "brightness",
    "contrast": "contrast",
    "hue": "hue",
    "wb_temperature": "white_balance",
    "exposure": "exposure",
    "focus": "focus",
}

# 有独立 control 对象、带 auto 开关的三个
WINRT_CONTROL_MAP = {
    "exposure": "exposure_control",
    "wb_temperature": "white_balance_control",
    "focus": "focus_control",
}


def out(obj):
    text = json.dumps(obj, ensure_ascii=False)
    # host 那边通过管道收不到（venv 的 python.exe 是个 shim），所以同时写一份
    # 到 SENSES_JSON_OUT 指定的文件，那边优先读文件。
    path = os.environ.get("SENSES_JSON_OUT")
    if path:
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
        except Exception:
            pass
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except Exception:
        pass


def open_cam(index, width=0, height=0):
    cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap.release()
        return None
    if width:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    if height:
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    return cap


def friendly_names():
    """Device names straight from Windows; order matches opencv indexes."""
    try:
        from winrt.windows.devices.enumeration import DeviceClass, DeviceInformation
    except Exception:
        return []

    async def run():
        devices = await DeviceInformation.find_all_async(DeviceClass.VIDEO_CAPTURE)
        return [(d.name, d.id) for d in devices]

    try:
        return asyncio.run(run())
    except Exception:
        return []


def readable_props(cap):
    values = {}
    for name, prop in PROPS.items():
        try:
            v = cap.get(prop)
            values[name] = None if v is None or v != v else round(float(v), 4)
        except Exception:
            values[name] = None
    try:
        values["auto_exposure"] = round(float(cap.get(cv2.CAP_PROP_AUTO_EXPOSURE)), 4)
    except Exception:
        values["auto_exposure"] = None
    try:
        values["auto_wb"] = round(float(cap.get(cv2.CAP_PROP_AUTO_WB)), 4)
    except Exception:
        values["auto_wb"] = None
    return values


# ---------------------------------------------------------------- WinRT 通道

async def _winrt_devices():
    from winrt.windows.devices.enumeration import DeviceClass, DeviceInformation

    devices = await DeviceInformation.find_all_async(DeviceClass.VIDEO_CAPTURE)
    return [(d.name, d.id) for d in devices]


async def _winrt_with_capture(index, name, fn):
    """打开一次 MediaCapture 跑 fn(controller)，然后释放。

    index/name 二选一：name 优先（OpenCV 的序号和 WinRT 的枚举顺序不保证一致）。
    """
    from winrt.windows.media.capture import (
        MediaCapture,
        MediaCaptureInitializationSettings,
        MediaCaptureSharingMode,
        StreamingCaptureMode,
    )

    try:
        devices = await _winrt_devices()
    except Exception as exc:
        return {"ok": False, "error": "WinRT 枚举失败: %s: %s" % (type(exc).__name__, exc)}

    if not devices:
        return {"ok": False, "error": "WinRT 里一个摄像头都没有"}

    picked = None
    if name:
        for item in devices:
            if item[0] == name:
                picked = item
                break
    if picked is None and index is not None and 0 <= index < len(devices):
        picked = devices[index]
    if picked is None:
        return {
            "ok": False,
            "error": "WinRT 里找不到设备（name=%s index=%s）" % (name, index),
            "names": [n for n, _ in devices],
        }

    settings = MediaCaptureInitializationSettings()
    settings.video_device_id = picked[1]
    settings.streaming_capture_mode = StreamingCaptureMode.VIDEO
    # SHARED_READ_ONLY：别的程序正在用时也尽量能开；独占会被拒。
    settings.sharing_mode = MediaCaptureSharingMode.SHARED_READ_ONLY
    cap = MediaCapture()
    try:
        await cap.initialize_async(settings)
    except Exception as exc:
        return {
            "ok": False,
            "error": "打开摄像头失败（可能被别的程序占用）: %s: %s" % (type(exc).__name__, exc),
            "name": picked[0],
        }
    try:
        result = await fn(cap.video_device_controller)
        if isinstance(result, dict):
            result.setdefault("name", picked[0])
        return result
    except Exception as exc:
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "name": picked[0]}
    finally:
        try:
            await cap.stop_preview_async()
        except Exception:
            pass


def _read_one(ctrl, winrt_name):
    """读一个 MediaDeviceControl：value + capabilities。"""
    try:
        node = getattr(ctrl, winrt_name)
    except Exception:
        return None
    entry = {}
    try:
        got = node.try_get_value()
        # pywinrt 返回 (bool, float)
        if isinstance(got, (list, tuple)) and len(got) >= 2:
            entry["ok"] = bool(got[0])
            entry["value"] = round(float(got[1]), 4) if got[0] else None
        else:
            entry["ok"] = bool(got)
            entry["value"] = None
    except Exception as exc:
        entry["value"] = None
        entry["valueErr"] = str(exc)
    try:
        c = node.capabilities
        entry.update({
            "supported": bool(c.supported),
            "min": round(float(c.min), 4),
            "max": round(float(c.max), 4),
            "step": round(float(c.step), 4),
            "default": round(float(c.default), 4),
            "autoSupported": bool(c.auto_mode_supported),
        })
    except Exception as exc:
        entry["capErr"] = str(exc)
    return entry


def _read_auto(ctrl, control_name):
    """读 exposure/white_balance/focus 的自动模式开关。"""
    try:
        node = getattr(ctrl, control_name)
        return bool(node.auto)
    except Exception:
        return None


def _write_one(ctrl, winrt_name, value):
    try:
        node = getattr(ctrl, winrt_name)
    except Exception as exc:
        return {"ok": False, "error": "这个设备没有该项: %s" % exc}
    try:
        ok = node.try_set_value(float(value))
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    try:
        got = node.try_get_value()
        back = round(float(got[1]), 4) if isinstance(got, (list, tuple)) and got[0] else None
    except Exception:
        back = None
    return {"ok": bool(ok), "value": back}


def _write_auto(ctrl, control_name, on):
    try:
        node = getattr(ctrl, control_name)
    except Exception as exc:
        return {"ok": False, "error": "没有自动模式: %s" % exc}
    try:
        node.auto = bool(on)
        return {"ok": True, "auto": bool(node.auto)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def cmd_range(args):
    """WinRT 读权威范围 + 当前值；WinRT 没有的那几项退回 OpenCV。"""

    async def work(ctrl):
        controls = {}
        for key, winrt_name in WINRT_MAP.items():
            entry = _read_one(ctrl, winrt_name)
            if entry is None:
                continue
            entry["by"] = "winrt"
            auto_name = WINRT_CONTROL_MAP.get(key)
            if auto_name:
                entry["auto"] = _read_auto(ctrl, auto_name)
            controls[key] = entry
        return {"ok": True, "controls": controls}

    res = asyncio.run(_winrt_with_capture(args.device, args.name, work))
    controls = res.pop("controls", {}) if isinstance(res, dict) else {}
    ok = bool(res.get("ok"))

    # OpenCV 侧补：当前值（所有项）+ WinRT 拿不到的几项给个估值范围
    # --no-probe：预览流正占着摄像头时不要再来开一次。第二次打开会抢不到设备，
    # 反过来把流饿死（实测流会一帧都读不出来）。
    ocv = {}
    if not getattr(args, "no_probe", False):
        cap = open_cam(args.device)
        if cap is not None:
            try:
                for _ in range(4):
                    cap.read()
                ocv = readable_props(cap)
            finally:
                cap.release()

    for key in PROPS:
        entry = controls.get(key)
        cur = ocv.get(key)
        if key in WINRT_MAP:
            if entry is None:
                # WinRT 读失败这一项：至少给当前值
                entry = {"by": "opencv", "supported": cur is not None and cur >= 0}
                if cur is not None:
                    entry["value"] = cur
                controls[key] = entry
            elif cur is not None and cur >= 0 and entry.get("value") is None:
                entry["value"] = cur
            continue
        # saturation / sharpness / gain / gamma：WinRT 没有，只能估
        supported = cur is not None and cur >= 0
        if supported:
            top = 255.0 if cur > 100 else 100.0
            controls[key] = {
                "by": "opencv",
                "supported": True,
                "value": cur,
                "min": 0.0,
                "max": top,
                "step": 1.0,
                "default": None,
                "guessRange": True,
            }
        else:
            controls[key] = {"by": "opencv", "supported": False, "value": cur}

    out({
        "ok": ok or bool(ocv),
        "error": None if (ok or ocv) else (
            (res.get("error") if isinstance(res, dict) else None) or "摄像头打不开"
        ),
        "source": "winrt" if ok else "opencv",
        "index": args.device,
        "name": res.get("name") if isinstance(res, dict) else None,
        "winrtError": None if ok else (res.get("error") if isinstance(res, dict) else "未知"),
        "controls": controls,
    })
    return 0 if (ok or ocv) else 1


def cmd_set(args):
    """WinRT 写参数。写不了（没有该项/不支持）就如实报，不假装成功。"""
    wanted = {}
    for key in WINRT_MAP:
        value = getattr(args, key, None)
        if value is not None:
            wanted[key] = value
    autos = {}
    if args.auto_exposure is not None:
        autos["exposure"] = args.auto_exposure
    if args.auto_wb is not None:
        autos["wb_temperature"] = args.auto_wb

    if not wanted and not autos:
        out({"ok": False, "error": "没有要写的参数"})
        return 1

    async def work(ctrl):
        applied = {}
        failed = {}
        # 先关自动再写值，否则写进去会被自动模式覆盖
        for key, on in autos.items():
            name = WINRT_CONTROL_MAP.get(key)
            if not name:
                continue
            r = _write_auto(ctrl, name, on)
            (applied if r.get("ok") else failed)["auto:" + key] = r.get("auto", r.get("error"))
        for key, value in wanted.items():
            winrt_name = WINRT_MAP[key]
            r = _write_one(ctrl, winrt_name, value)
            if r.get("ok"):
                applied[key] = r.get("value")
            else:
                failed[key] = r.get("error")
        return {"ok": True, "applied": applied, "failed": failed, "honored": not failed}

    res = asyncio.run(_winrt_with_capture(args.device, args.name, work))
    if isinstance(res, dict) and res.get("ok"):
        res["index"] = args.device
    out(res)
    return 0 if (isinstance(res, dict) and res.get("ok")) else 1


# ---------------------------------------------------------------- OpenCV 通道

def cmd_list(args):
    names = friendly_names()

    # --no-probe：预览流正占着摄像头时，别再用 OpenCV 去逐个打开设备。
    # 一台摄像头被两个实例同时开，「后来那个」会把「先来的那个」饿死
    # （实测：流一帧都读不出来）。这时只报 WinRT 看到的设备名。
    if getattr(args, "no_probe", False) and names:
        cams = [{
            "index": i,
            "name": nm,
            "width": 0,
            "height": 0,
            "fps": None,
            "readable": True,
            "probed": False,
        } for i, (nm, _dev_id) in enumerate(names)]
        out({"ok": True, "cameras": cams, "winrtNames": [n for n, _ in names], "noProbe": True})
        return 0

    cams = []
    for i in range(6):
        cap = open_cam(i)
        if cap is None:
            continue
        try:
            ok, frame = cap.read()
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            fps = cap.get(cv2.CAP_PROP_FPS)
            label = names[i][0] if i < len(names) else f"camera {i}"
            cams.append({
                "index": i,
                "name": label,
                "width": w,
                "height": h,
                "fps": round(float(fps), 2) if fps else None,
                "readable": bool(ok),
            })
        finally:
            cap.release()
    out({"ok": True, "cameras": cams, "winrtNames": [n for n, _ in names]})
    return 0


def cmd_info(args):
    cap = open_cam(args.device, args.width, args.height)
    if cap is None:
        out({"ok": False, "error": f"打不开摄像头 index {args.device}"})
        return 1
    try:
        awake = None
        for _ in range(8):
            ok, frame = cap.read()
            if ok and frame is not None:
                awake = frame.shape
        data = {
            "ok": True,
            "index": args.device,
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
            "fps": round(float(cap.get(cv2.CAP_PROP_FPS) or 0), 2),
            "frame": None if awake is None else {"h": awake[0], "w": awake[1]},
            "props": readable_props(cap),
        }
        out(data)
        return 0
    finally:
        cap.release()


def cmd_snap(args):
    cap = open_cam(args.device, args.width, args.height)
    if cap is None:
        out({"ok": False, "error": f"打不开摄像头 index {args.device}"})
        return 1
    applied = {}
    try:
        # manual knobs first, then let the sensor settle
        for name, prop in PROPS.items():
            raw = getattr(args, name, None)
            if raw is None:
                continue
            try:
                cap.set(prop, float(raw))
                back = cap.get(prop)
                applied[name] = round(float(back), 4) if back is not None else None
            except Exception:
                applied[name] = "error"

        frame = None
        for _ in range(max(1, args.warmup)):
            ok, f = cap.read()
            if ok and f is not None:
                frame = f
        if frame is None:
            out({"ok": False, "error": "摄像头没有出帧"})
            return 1
        if args.mirror:
            frame = cv2.flip(frame, 1)

        dest = os.path.abspath(args.out)
        parent = os.path.dirname(dest)
        if parent:
            os.makedirs(parent, exist_ok=True)
        ok = cv2.imwrite(dest, frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(args.quality)])
        if not ok:
            out({"ok": False, "error": f"写文件失败 {dest}"})
            return 1
        h, w = frame.shape[:2]
        out({
            "ok": True,
            "path": dest,
            "width": w,
            "height": h,
            "bytes": os.path.getsize(dest),
            "applied": applied,
        })
        return 0
    finally:
        cap.release()


def cmd_person(args):
    """抓一帧，判断画面里有没有人（给情绪引擎 60 分那级用）。

    用 OpenCV 自带的 Haar 正脸模型 —— 在本机就能跑，不联网、不花 token。
    ⚠ 只看一眼就删：图写到临时文件、检测完立刻删掉，不在盘上留照片。
    ⚠ 它只认正脸：低头、侧脸、背光时可能漏。所以结论说清楚：
       person=True   看到脸了
       person=False  没看到（可能没人，也可能只是没对着镜头）
       person=None   画面太暗，判断不了（看 undecided）
    """
    dest = None
    cap = open_cam(args.device, args.width, args.height)
    if cap is None:
        out({"ok": False, "error": f"打不开摄像头 index {args.device}"})
        return 1
    try:
        frame = None
        for _ in range(max(1, args.warmup)):
            ok, f = cap.read()
            if ok and f is not None:
                frame = f
        if frame is None:
            out({"ok": False, "error": "摄像头没有出帧"})
            return 1
        if args.mirror:
            frame = cv2.flip(frame, 1)

        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        brightness = float(gray.mean())

        dest = os.path.abspath(args.out)
        parent = os.path.dirname(dest)
        if parent:
            os.makedirs(parent, exist_ok=True)
        cv2.imwrite(dest, frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(args.quality)])

        faces = ()
        err = ""
        try:
            cascade = cv2.CascadeClassifier(
                os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
            if cascade.empty():
                err = "找不到 Haar 模型文件"
            else:
                faces = cascade.detectMultiScale(
                    gray, scaleFactor=1.12, minNeighbors=5,
                    minSize=(max(24, int(w * 0.06)), max(24, int(h * 0.06))))
        except Exception as exc:  # noqa: BLE001
            err = f"{type(exc).__name__}: {exc}"

        # 太暗就当判断不了，别硬说「没人」
        undecided = brightness < 16
        person = None if (undecided or err) else bool(len(faces))
        out({
            "ok": True,
            "person": person,
            "undecided": undecided,
            "faces": int(len(faces)),
            "brightness": round(brightness, 1),
            "saved": False,
            "width": w,
            "height": h,
            "error": err or None,
        })
        return 0
    finally:
        cap.release()
        # 看一眼就删：不留在盘上
        try:
            if dest and os.path.exists(dest):
                os.remove(dest)
        except Exception:
            pass


def cmd_caps(args):
    """兼容旧调用：现在直接复用 range 的结果。"""
    class _Args:
        device = args.device
        name = getattr(args, "name", None)
        no_probe = getattr(args, "no_probe", False)
    return cmd_range(_Args())


def cmd_setocv(args):
    """WinRT 管不到的几项（saturation / sharpness / gain / gamma）只能靠 OpenCV 写。

    这几项没有权威值域，写完只报读回值；能被设备拒绝的照实说 rejected。
    """
    wanted = {}
    for name in PROPS:
        raw = getattr(args, name, None)
        if raw is not None:
            wanted[name] = raw
    if not wanted:
        out({"ok": False, "error": "没有要写的参数"})
        return 1
    cap = open_cam(args.device)
    if cap is None:
        out({"ok": False, "error": f"打不开摄像头 index {args.device}"})
        return 1
    applied = {}
    failed = {}
    try:
        for _ in range(3):
            cap.read()
        for name, raw in wanted.items():
            prop = PROPS[name]
            try:
                ok = cap.set(prop, float(raw))
                for _ in range(2):
                    cap.read()
                back = cap.get(prop)
                if back is None or back != back:
                    failed[name] = "读不回来"
                elif abs(float(back) - float(raw)) > 0.51:
                    # 读回值不等于请求值 = 设备没接受（夹到边界或这项根本改不动）
                    failed[name] = "设备没接受，读回 %s" % round(float(back), 3)
                elif not ok:
                    failed[name] = "设备拒绝了这个值"
                else:
                    applied[name] = round(float(back), 4)
            except Exception as exc:
                failed[name] = "%s: %s" % (type(exc).__name__, exc)
        out({"ok": True, "by": "opencv", "applied": applied, "failed": failed})
        return 0
    finally:
        cap.release()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("--no-probe", dest="no_probe", action="store_true",
                        help="只报 WinRT 看到的设备，不用 OpenCV 打开它们（流在跑时必须加）")
    p_list.set_defaults(fn=cmd_list)

    p_info = sub.add_parser("info")
    p_info.add_argument("--device", type=int, required=True)
    p_info.add_argument("--width", type=int, default=0)
    p_info.add_argument("--height", type=int, default=0)
    p_info.set_defaults(fn=cmd_info)

    p_caps = sub.add_parser("caps")
    p_caps.add_argument("--device", type=int, required=True)
    p_caps.add_argument("--name", type=str, default=None)
    p_caps.set_defaults(fn=cmd_caps)

    p_setocv = sub.add_parser("setocv")
    p_setocv.add_argument("--device", type=int, required=True)
    for name in PROPS:
        p_setocv.add_argument("--" + name.replace("_", "-"), dest=name, type=float, default=None)
    p_setocv.set_defaults(fn=cmd_setocv)

    p_range = sub.add_parser("range")
    p_range.add_argument("--device", type=int, required=True)
    p_range.add_argument("--name", type=str, default=None)
    p_range.add_argument("--no-probe", dest="no_probe", action="store_true",
                         help="跳过 OpenCV 读值那一步（流在跑时必须加，否则会互相抢设备）")
    p_range.set_defaults(fn=cmd_range)

    p_set = sub.add_parser("set")
    p_set.add_argument("--device", type=int, required=True)
    p_set.add_argument("--name", type=str, default=None)
    for key in WINRT_MAP:
        p_set.add_argument("--" + key.replace("_", "-"), dest=key, type=float, default=None)
    p_set.add_argument("--auto-exposure", dest="auto_exposure", type=int, default=None)
    p_set.add_argument("--auto-wb", dest="auto_wb", type=int, default=None)
    p_set.set_defaults(fn=cmd_set)

    p_snap = sub.add_parser("snap")
    p_snap.add_argument("--device", type=int, default=0)
    p_snap.add_argument("--width", type=int, default=1280)
    p_snap.add_argument("--height", type=int, default=720)
    p_snap.add_argument("--out", required=True)
    p_snap.add_argument("--quality", type=int, default=92)
    p_snap.add_argument("--warmup", type=int, default=12)
    p_snap.add_argument("--mirror", action="store_true")
    for name in PROPS:
        p_snap.add_argument("--" + name.replace("_", "-"), dest=name, type=float, default=None)
    p_snap.add_argument("--auto-wb", dest="auto_wb", type=int, default=None)
    p_snap.add_argument("--auto-exposure", dest="auto_exposure", type=int, default=None)
    p_snap.set_defaults(fn=cmd_snap)

    p_person = sub.add_parser("person")
    p_person.add_argument("--device", type=int, default=0)
    p_person.add_argument("--width", type=int, default=1280)
    p_person.add_argument("--height", type=int, default=720)
    p_person.add_argument("--out", required=True)
    p_person.add_argument("--quality", type=int, default=88)
    p_person.add_argument("--warmup", type=int, default=12)
    p_person.add_argument("--mirror", action="store_true")
    p_person.set_defaults(fn=cmd_person)

    args = ap.parse_args()
    try:
        return args.fn(args) or 0
    except Exception as exc:  # noqa: BLE001
        out({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 2


if __name__ == "__main__":
    sys.exit(main())
