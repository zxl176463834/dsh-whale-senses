#!/usr/bin/env python
"""dsh-whale-senses — 实时预览出帧器。

持续抓帧，把 JPEG 按 multipart/x-mixed-replace 的格式直接写到标准输出。
host 那边只做两件事：写响应头、把 stdout 原样列给浏览器。零解析。

为什么要单独一个进程：调参要在画面上看得见才有意义。拍一张看一眼那种
每次都要开关设备（2-3 秒），调到舒服的位置得来回十几次，根本没法调。

边界：
  * 只负责出流，不落盘、不改参数（参数是设备级的，WinRT 那边写进去这个进程
    的下一帧就跟着变）。
  * 客户端一断，stdout 写就会抛 BrokenPipeError，进程自己退出，不留孤儿。
"""
import argparse
import os
import sys
import time

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
os.environ.setdefault("OPENCV_VIDEOIO_DEBUG", "0")
os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", "0")

import cv2

BOUNDARY = b"--frame"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=float, default=15.0)
    ap.add_argument("--quality", type=int, default=75)
    ap.add_argument("--mirror", action="store_true")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.device, cv2.CAP_DSHOW)
    if not cap.isOpened():
        sys.stderr.write("打不开摄像头 index %d\n" % args.device)
        return 1

    if args.width:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    if args.height:
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)

    # 摄像头刚打开的前几帧是黑的，先吃掉
    for _ in range(8):
        cap.read()

    out = sys.stdout.buffer
    interval = 1.0 / max(1.0, min(60.0, args.fps))
    quality = [int(cv2.IMWRITE_JPEG_QUALITY), max(30, min(95, args.quality))]
    sent = 0
    fails = 0

    try:
        while True:
            t0 = time.time()
            ok, frame = cap.read()
            if not ok or frame is None:
                fails += 1
                # 连续读不到 = 设备被别的程序抢走了，隔一秒重开一次试着抢回来
                if fails % 25 == 0:
                    try:
                        sys.stderr.write("连续 %d 帧读不到，重开设备\n" % fails)
                        sys.stderr.flush()
                    except Exception:
                        pass
                    try:
                        cap.release()
                    except Exception:
                        pass
                    cap = cv2.VideoCapture(args.device, cv2.CAP_DSHOW)
                    if cap.isOpened():
                        if args.width:
                            cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
                        if args.height:
                            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
                        for _ in range(5):
                            cap.read()
                time.sleep(0.05)
                continue
            fails = 0
            if args.mirror:
                frame = cv2.flip(frame, 1)
            ok2, buf = cv2.imencode(".jpg", frame, quality)
            if not ok2:
                continue
            data = buf.tobytes()
            out.write(BOUNDARY + b"\r\n")
            out.write(b"Content-Type: image/jpeg\r\n")
            out.write(b"Content-Length: " + str(len(data)).encode("ascii") + b"\r\n\r\n")
            out.write(data)
            out.write(b"\r\n")
            out.flush()
            sent += 1
            rest = interval - (time.time() - t0)
            if rest > 0:
                time.sleep(rest)
    except (BrokenPipeError, ConnectionResetError):
        pass
    except KeyboardInterrupt:
        pass
    finally:
        try:
            cap.release()
        except Exception:
            pass
        try:
            sys.stderr.write("流结束，共 %d 帧\n" % sent)
            sys.stderr.flush()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
