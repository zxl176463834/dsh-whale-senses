# -*- coding: utf-8 -*-
"""dsh-voice-out 本地 TTS 服务：模型常驻 + 空闲卸载，只监听 127.0.0.1。"""
import gc
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.environ.get("VOICE_OUT_APP", "")

# 「口」需要一个本机 TTS 引擎目录（你装的那份，不在本仓库里）。
# 没配就直接退出并说清楚，别在 os.chdir 那里抛一个看不懂的异常。
if not APP_DIR:
    sys.stderr.write("[tts] 未配置 TTS 引擎目录。请设置环境变量 VOICE_OUT_APP 指向你的 TTS 程序目录（含 checkpoints）。\n")
    sys.exit(2)
if not os.path.isdir(APP_DIR):
    sys.stderr.write("[tts] TTS 引擎目录不存在：%s\n" % APP_DIR)
    sys.exit(2)
CKPT = os.path.join(APP_DIR, "checkpoints")

# —— 引擎选择：qwen3tts（默认）或 indextts（旧）——
ENGINE = os.environ.get("VOICE_OUT_ENGINE", "qwen")
QWEN_ROOT = os.environ.get("VOICE_OUT_QWEN_ROOT", "")
QWEN_MODEL = os.environ.get("VOICE_OUT_QWEN_MODEL", "")
# VoiceDesign 是"每句现场设计一个新音色"，VoiceClone 才是复刻固定音色——后者要 Base 模型
QWEN_BASE_MODEL = os.environ.get("VOICE_OUT_QWEN_BASE", "")
DEFAULT_INSTRUCT = os.environ.get("VOICE_OUT_INSTRUCT", "")

os.chdir(APP_DIR)
sys.path.insert(0, APP_DIR)
os.environ.setdefault("HF_HUB_CACHE", "./checkpoints/hf_cache")
os.environ.setdefault("PYTHONPATH", ".")

GEN_LOCK = threading.Lock()
STATE = {"tts": None, "loaded_at": 0.0, "last_use": 0.0, "idle_min": 15.0, "error": "", "count": 0,
         "engine": ENGINE, "loaded_engine": None}


def split_cues(text):
    """按语义切 cue：先按句末标点分段，再按逗号并句到 12–32 字；返回 (文本, 句后停顿ms)。"""
    import re as _re
    segs = _re.findall(r"[^。！？；!?;…\n]+[。！？；!?;…\n]?", text.strip())
    cues = []
    for seg in segs:
        seg = seg.strip()
        if not seg:
            continue
        parts = _re.findall(r"[^，,]+[，,]?", seg)
        buf = ""
        for p in parts:
            if not buf:
                buf = p
            elif len(buf) < 12 and len(buf) + len(p) <= 32:
                buf += p
            else:
                cues.append(buf)
                buf = p
            while len(buf) > 40:
                cues.append(buf[:32])
                buf = buf[32:]
        if buf:
            cues.append(buf)
    out = []
    for c in cues:
        c = c.strip()
        if not c:
            continue
        last = c[-1]
        if last in "。！？!?":
            pause = 550
        elif last in "；;…":
            pause = 450
        elif last in "，,":
            pause = 350
        elif last in "、":
            pause = 250
        else:
            pause = 200
        out.append((c, pause))
    return out


def log(msg):
    sys.stderr.write("[voice-out] " + str(msg) + "\n")
    sys.stderr.flush()


def load_model(engine=None):
    eng = (engine or STATE.get("engine") or ENGINE).lower()
    if STATE["tts"] is not None and STATE.get("loaded_engine") == eng:
        return STATE["tts"]
    if STATE["tts"] is not None:
        unload_model("切换到 " + eng)
    t0 = time.time()
    if eng in ("qwen", "qwenclone"):
        import torch
        if QWEN_ROOT not in sys.path:
            sys.path.insert(0, QWEN_ROOT)
        from qwen_tts_webui.qwen_tts import Qwen3TTSModel
        model_path = QWEN_BASE_MODEL if eng == "qwenclone" else QWEN_MODEL
        STATE["tts"] = Qwen3TTSModel.from_pretrained(
            pretrained_model_name_or_path=model_path,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="eager",
            fast_generation=False,
            use_cuda_graph=False,
        )
    else:
        from indextts.infer_v2_5 import IndexTTS2
        STATE["tts"] = IndexTTS2(cfg_path=os.path.join(CKPT, "config.yaml"), model_dir=CKPT, use_bf16=True)
    STATE["loaded_engine"] = eng
    STATE["loaded_at"] = time.time()
    STATE["error"] = ""
    log("模型加载完成 %.1fs (engine=%s)" % (time.time() - t0, eng))
    return STATE["tts"]


def unload_model(reason=""):
    if STATE["tts"] is None:
        return False
    STATE["tts"] = None
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass
    log("模型已卸载 %s" % reason)
    return True


def idle_watch():
    while True:
        time.sleep(20)
        try:
            if STATE["tts"] is None:
                continue
            since = max(STATE["last_use"] or 0.0, STATE["loaded_at"] or 0.0) or time.time()
            idle = time.time() - since
            if idle > STATE["idle_min"] * 60:
                with GEN_LOCK:
                    if STATE["tts"] is not None:
                        unload_model("空闲 %.0f 秒（loaded_at=%.0f last_use=%.0f）" % (idle, STATE["loaded_at"], STATE["last_use"]))
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            loaded = STATE["tts"] is not None
            self._json(200, {
                "ok": True,
                "loaded": loaded,
                "idleSeconds": round(time.time() - STATE["last_use"], 1) if STATE["last_use"] else 0,
                "idleMinutes": STATE["idle_min"],
                "count": STATE["count"],
                "error": STATE["error"],
                "engine": STATE.get("loaded_engine") or STATE.get("engine"),
            })
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            if self.path.startswith("/config"):
                body = self._body()
                if isinstance(body.get("idleMinutes"), (int, float)):
                    STATE["idle_min"] = max(1.0, min(180.0, float(body["idleMinutes"])))
                if isinstance(body.get("engine"), str) and body["engine"].lower() in ("qwen", "indextts"):
                    STATE["engine"] = body["engine"].lower()
                self._json(200, {"ok": True, "idleMinutes": STATE["idle_min"], "engine": STATE["engine"]})
                return
            if self.path.startswith("/unload"):
                with GEN_LOCK:
                    did = unload_model("手动卸载")
                self._json(200, {"ok": True, "unloaded": did})
                return
            if self.path.startswith("/speak"):
                body = self._body()
                text = str(body.get("text") or "").strip()
                if not text:
                    self._json(400, {"ok": False, "error": "text 为空"})
                    return
                voice = str(body.get("voice") or "examples/voice_09.wav")
                if not os.path.isabs(voice):
                    voice = os.path.join(APP_DIR, voice)
                speed = float(body.get("speed") or 1.0)
                happy = float(body.get("happy") or 0.0)
                calm = float(body.get("calm") or 0.0)
                out = os.path.join(APP_DIR, "..", "_cache", "vo_%d.wav" % int(time.time() * 1000))
                out = os.path.abspath(out)
                engine = str(body.get("engine") or STATE.get("engine") or ENGINE).lower()
                instruct = str(body.get("instruct") or DEFAULT_INSTRUCT or "")
                # 有基准音就复刻它（音色稳定），没有才现场设计（每句都会变）
                ref_wav = str(body.get("refWav") or "").strip()
                ref_text = str(body.get("refText") or "").strip()
                if ref_wav and not os.path.isabs(ref_wav):
                    ref_wav = os.path.join(APP_DIR, ref_wav)
                if ref_wav and not os.path.exists(ref_wav):
                    log("基准音不存在，退回现场设计: " + ref_wav)
                    ref_wav = ""
                use_clone = bool(ref_wav and ref_text)
                if use_clone and engine == "qwen":
                    engine = "qwenclone"
                with GEN_LOCK:
                    tts = load_model(engine)
                    t0 = time.time()
                    if engine in ("qwen", "qwenclone"):
                        import soundfile as sf

                        def _gen(t):
                            if use_clone:
                                w, s = tts.generate_voice_clone(
                                    text=t, ref_audio=ref_wav, ref_text=ref_text, language="Chinese")
                                return w[0], s
                            w, s = tts.generate_voice_design(
                                text=t, instruct=instruct, language="Chinese")
                            return w[0], s

                        if body.get("precise"):
                            import numpy as np
                            cues = split_cues(text)
                            chunks = []
                            sr = 24000
                            for cue, pause in cues:
                                one, sr = _gen(cue)
                                chunks.append(np.asarray(one, dtype=np.float32))
                                if pause:
                                    chunks.append(np.zeros(int(sr * pause / 1000.0), dtype=np.float32))
                                STATE["last_use"] = time.time()
                            sf.write(out, np.concatenate(chunks), sr)
                            log("精确模式：%d 句，停顿合计 %d ms" % (len(cues), sum(p for _, p in cues)))
                        else:
                            one, sr = _gen(text)
                            sf.write(out, one, sr)
                    else:
                        kw = {"duration_factor": speed}
                        if happy or calm:
                            kw["emo_vector"] = [happy, 0, 0, 0, 0, 0, 0, calm]
                        tts.infer(spk_audio_prompt=voice, text=text, lang="ZH", output_path=out, verbose=False, **kw)
                    STATE["last_use"] = time.time()
                    STATE["count"] += 1
                    log("生成 %.1fs %d 字 -> %s" % (time.time() - t0, len(text), os.path.basename(out)))
                with open(out, "rb") as f:
                    data = f.read()
                try:
                    os.remove(out)
                except Exception:
                    pass
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            STATE["error"] = "%s: %s" % (type(e).__name__, str(e)[:200])
            log(traceback.format_exc()[-800:])
            try:
                self._json(500, {"ok": False, "error": STATE["error"]})
            except Exception:
                pass


def main():
    threading.Thread(target=idle_watch, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    sys.stdout.write("PORT=%d\n" % port)
    sys.stdout.flush()
    log("监听 127.0.0.1:%d" % port)
    srv.serve_forever()


if __name__ == "__main__":
    main()
