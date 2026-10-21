#!/usr/bin/env python3
"""pp1 协议级端到端验证（客户端视角，纯标准库）。

手写 MessagePack 编解码，避免在节点上装依赖。走 ingress 的 https，
但强制连 127.0.0.1:443（SNI 用真实主机名），这样既能验证书又能绕开节点上的 VPN fake-ip，
所以脚本要在 ingress 所在的节点（或能直连它 443 的机器）上跑。

  python3 verify-protocol.py            # 全流程
  python3 verify-protocol.py --insecure # 证书没签出来时先跑链路

三个地址默认是模板值（pp1.example.com 等），按自己的域名覆盖：

  BRAIN_HOST=pp1.<域名> ASR_HOST=pp1-asr.<域名> TTS_HOST=pp1-tts.<域名> python3 verify-protocol.py

brain 开了鉴权之后要先给 token（只加在 brain 那三个端点上；asr/tts 不鉴权）：

  BRAIN_TOKEN=$(cat <token 文件>) python3 verify-protocol.py
"""
import json, os, socket, ssl, struct, sys, time

HOST = os.environ.get("BRAIN_HOST", "pp1.example.com")
ASR_HOST = os.environ.get("ASR_HOST", "pp1-asr.example.com")
TTS_HOST = os.environ.get("TTS_HOST", "pp1-tts.example.com")
# brain_id 是会话名字，每次跑用新的，免得上一轮的残留消息排在前头；
# 服务端会在第一次出现时现建，空名也允许（闲时自动卸载）。
BRAIN_ID = "verify-%d" % int(time.time())
LONG_BRAIN_ID = BRAIN_ID + "-long"
VOICE = "male-fun"
# 部署启用了 brain 鉴权（MIGHT_BRAINS_TOKEN 非空）时必须带上，否则四个端点全 401。
TOKEN = os.environ.get("BRAIN_TOKEN", "").strip()

# ── 最小 MessagePack（只覆盖 map / str / bin / int）────────────────────────
def mp_pack(obj):
    if isinstance(obj, dict):
        out = bytes([0x80 | len(obj)])
        for k, v in obj.items():
            out += mp_pack(k) + mp_pack(v)
        return out
    if isinstance(obj, str):
        b = obj.encode()
        return (bytes([0xA0 | len(b)]) if len(b) < 32 else b"\xd9" + bytes([len(b)])) + b
    if isinstance(obj, (bytes, bytearray)):
        b = bytes(obj)
        if len(b) < 256:
            return b"\xc4" + bytes([len(b)]) + b
        if len(b) < 65536:
            return b"\xc5" + struct.pack(">H", len(b)) + b
        return b"\xc6" + struct.pack(">I", len(b)) + b
    if isinstance(obj, int):
        if 0 <= obj < 128:
            return bytes([obj])
        if -32 <= obj < 0:
            return bytes([0x100 + obj])
        return b"\xd2" + struct.pack(">i", obj)
    raise TypeError(type(obj))


def mp_unpack(buf, i=0):
    c = buf[i]
    if 0x80 <= c <= 0x8F:
        n = c & 0x0F
        out = {}
        i += 1
        for _ in range(n):
            k, i = mp_unpack(buf, i)
            v, i = mp_unpack(buf, i)
            out[k] = v
        return out, i
    if 0xA0 <= c <= 0xBF:
        n = c & 0x1F
        return buf[i + 1:i + 1 + n].decode(), i + 1 + n
    if c == 0xD9:
        n = buf[i + 1]
        return buf[i + 2:i + 2 + n].decode(), i + 2 + n
    if c in (0xC4, 0xC5, 0xC6):
        w = {0xC4: 1, 0xC5: 2, 0xC6: 4}[c]
        n = int.from_bytes(buf[i + 1:i + 1 + w], "big")
        return bytes(buf[i + 1 + w:i + 1 + w + n]), i + 1 + w + n
    if c <= 0x7F:
        return c, i + 1
    if c >= 0xE0:
        return c - 0x100, i + 1
    if c == 0xD2:
        return struct.unpack(">i", buf[i + 1:i + 5])[0], i + 5
    raise ValueError(f"不支持的 msgpack 前缀 0x{c:02x}")


# ── 极简 HTTP 客户端（连 127.0.0.1，SNI/证书按真实主机名校验）───────────────
class Conn:
    def __init__(self, host, insecure=False):
        ctx = ssl.create_default_context()
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection(("127.0.0.1", 443), timeout=30)
        self.s = ctx.wrap_socket(raw, server_hostname=host)
        self.buf = b""
        # 只有 brain 那个 host 要 Authorization；token 为空时不发（对应服务端"空 = 不鉴权"）。
        self.auth = f"Bearer {TOKEN}" if (TOKEN and host == HOST) else ""

    def send(self, method, path, headers, body=b"", version="HTTP/1.1"):
        req = [f"{method} {path} {version}", f"Host: {headers.pop('Host')}"]
        if self.auth:
            req.append(f"Authorization: {self.auth}")
        for k, v in headers.items():
            req.append(f"{k}: {v}")
        req.append(f"Content-Length: {len(body)}")
        self.s.sendall(("\r\n".join(req) + "\r\n\r\n").encode() + body)

    def _fill(self):
        d = self.s.recv(65536)
        if not d:
            return False
        self.buf += d
        return True

    def read_headers(self):
        while b"\r\n\r\n" not in self.buf:
            if not self._fill():
                break
        head, _, rest = self.buf.partition(b"\r\n\r\n")
        self.buf = rest
        lines = head.decode("latin1").split("\r\n")
        status = int(lines[0].split()[1])
        hdrs = dict(
            (k.strip().lower(), v.strip())
            for k, _, v in (l.partition(":") for l in lines[1:])
            if _
        )
        return status, hdrs

    def read_exact(self, n):
        while len(self.buf) < n:
            if not self._fill():
                break
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_line(self):
        while b"\r\n" not in self.buf:
            if not self._fill():
                break
        line, _, rest = self.buf.partition(b"\r\n")
        self.buf = rest
        return line

    def iter_body(self):
        """按 Transfer-Encoding / Content-Length 逐段吐出解码后的 body。

        nginx 对没有 Content-Length 的流式响应用 chunked，不处理的话会把
        「块长度行」当成前导，解析全错（第一版就是这么挂的）。
        """
        if self.headers.get("transfer-encoding", "").lower() == "chunked":
            while True:
                line = self._read_line()
                if not line:
                    break
                size = int(line.split(b";")[0], 16)
                if size == 0:
                    while True:
                        trailer = self._read_line()
                        if trailer in (b"",):
                            break
                    break
                data = self.read_exact(size)
                self.read_exact(2)  # 块尾 CRLF
                if not data:
                    break
                yield data
        else:
            left = int(self.headers.get("content-length", 0))
            while left > 0:
                data = self.read_exact(min(left, 65536))
                if not data:
                    break
                left -= len(data)
                yield data

    def read_body(self):
        return b"".join(self.iter_body())

    def request_json(self, method, path, host, payload=None, raw=False):
        body = b""
        headers = {"Host": host}
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        self.send(method, path, headers, body)
        self.status, self.headers = self.read_headers()
        data = self.read_body()
        if raw:
            return self.status, data
        return self.status, (json.loads(data) if data else None)

    def request_msgpack(self, path, host, payload):
        self.send("POST", path, {"Host": host, "Content-Type": "application/msgpack"},
                  mp_pack(payload))
        self.status, self.headers = self.read_headers()
        return self.status, self.read_body()

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def stream_preamble(conn, brain_id=BRAIN_ID):
    """读 /brain-to-human 的响应：返回 (文本, flags, 前导到手耗时, 时间线, 总字节, 首字节时刻)。"""
    t0 = time.monotonic()
    conn.send("POST", "/brain-to-human",
              {"Host": HOST, "Content-Type": "application/msgpack"},
              mp_pack({"brain_id": brain_id}))
    status, headers = conn.read_headers()
    conn.headers = headers
    timeline = []
    body = bytearray()
    t_first_byte = None
    t_preamble = None
    need = 5  # 4 字节长度 + 至少 1 字节 flags（长度 0 时就是最短前导）
    chunks = 0
    for data in conn.iter_body():
        if t_first_byte is None:
            t_first_byte = time.monotonic() - t0
        chunks += 1
        body += data
        if len(body) >= 4:
            need = 4 + struct.unpack(">I", bytes(body[:4]))[0] + 1
        if t_preamble is None and len(body) >= need:
            t_preamble = time.monotonic() - t0
        timeline.append((round(time.monotonic() - t0, 3), len(body), chunks))
        # 前导到手后再多收 25 秒，足够看出「音频是否在持续吐」；然后主动断开
        # （主动断开也顺带验证了「客户端断开就停止合成」这条语义）
        if t_preamble is not None and time.monotonic() - t0 > t_preamble + 25.0:
            break
    conn.close()
    text_len = struct.unpack(">I", bytes(body[:4]))[0] if len(body) >= 5 else None
    text = body[4:4 + text_len].decode() if text_len is not None else None
    flags = body[4 + text_len] if text_len is not None and len(body) > 4 + text_len else None
    audio = bytes(body[4 + (text_len or 0) + (1 if flags is not None else 0):])
    return {
        "status": status, "headers": headers, "text": text, "flags": flags,
        "t_first_byte": t_first_byte, "t_preamble": t_preamble,
        "audio_head": audio[:4], "audio_bytes": len(audio),
        "timeline": timeline, "total_bytes": len(body),
        "content_type": headers.get("content-type"),
        "elapsed": time.monotonic() - t0,
    }


def print_timeline(r):
    """按 0.5 秒分桶，看字节是不是在持续增长（缓冲有没有关掉看这个）。"""
    print(f"  首字节    = {r['t_first_byte']:.3f}s   前导到手 = {r['t_preamble']:.3f}s   "
          f"完全结束 = {r['elapsed']:.3f}s")
    print(f"  音频      = {r['audio_bytes']} bytes, head={r['audio_head']!r}")
    print("  累计字节（0.5 秒一桶）:")
    buckets = {}
    for ts, nbytes, _ in r["timeline"]:
        buckets[int(ts / 0.5)] = nbytes
    for k in sorted(buckets):
        print(f"    {k * 0.5:5.1f}s {buckets[k]:9d} bytes")


def main():
    insecure = "--insecure" in sys.argv
    ok = True

    # 1) ASR / TTS 经 ingress 的健康检查
    for host, path in ((ASR_HOST, "/health"), (TTS_HOST, "/health")):
        c = Conn(host, insecure)
        t = time.monotonic()
        st, body = c.request_json("GET", path, host, raw=True)
        print(f"[ingress] https://{host}{path} -> {st} {body.decode(errors='replace')[:120]} "
              f"({time.monotonic() - t:.2f}s)")
        ok &= st == 200
        c.close()

    # 2) TTS 合成一段 Ogg Opus，当作上行音频
    c = Conn(TTS_HOST, insecure)
    t = time.monotonic()
    st, ogg = c.request_json("POST", "/v1/audio/speech/stream", TTS_HOST,
                             {"prompt": "你好，世界。", "voice": VOICE, "audio_format": "opus"},
                             raw=True)
    print(f"[TTS] {st} {len(ogg)} bytes, head={ogg[:4]!r} ({time.monotonic() - t:.2f}s)")
    ok &= st == 200 and ogg[:4] == b"OggS"
    c.close()
    open("/tmp/pp1-verify.ogg", "wb").write(ogg)

    # 3) 上行：把这段 Ogg Opus 交给 brain，期望拿到转写文本
    c = Conn(HOST, insecure)
    t = time.monotonic()
    st, body = c.request_msgpack("/human-to-brain", HOST,
                                 {"brain_id": BRAIN_ID, "audio": ogg})
    dt = time.monotonic() - t
    try:
        res, _ = mp_unpack(body)
    except Exception as e:  # noqa: BLE001
        res = {"decode_error": str(e), "raw_head": body[:80].hex()}
    print(f"[human-to-brain] {st} {dt:.2f}s -> {res}")
    ok &= st == 200 and res.get("kind") == "text" and bool(res.get("text"))
    c.close()

    # 4) agent 侧写入一条回复（agent-to-brain 支持 JSON）
    c = Conn(HOST, insecure)
    st, res = c.request_json("POST", "/agent-to-brain", HOST,
                             {"brain_id": BRAIN_ID, "text": "部署验证：这是一条测试回复。"})
    print(f"[agent-to-brain] {st} -> {res}")
    ok &= st == 200
    c.close()

    # 5) 下行：前导 + 连续 Ogg 流，并且要看得出「边合成边吐」
    c = Conn(HOST, insecure)
    r = stream_preamble(c)
    c.close()
    print(f"[brain-to-human] {r['status']} content-type={r['content_type']}")
    print(f"  前导文本  = {r['text']!r}")
    print(f"  flags     = {r['flags']}")
    print_timeline(r)
    ok &= r["status"] == 200 and r["flags"] == 0 and r["audio_head"] == b"OggS"
    ok &= r["t_preamble"] is not None and r["t_preamble"] < 1.0
    ok &= r["timeline"][-1][1] > r["timeline"][0][1]

    # 6) 长回复：合成要花好几秒，这时候「前导立刻到 + 字节持续增长」才是有力证据
    long_text = (
        "这是一条比较长的回复，用来观察下行流式行为。"
        "如果网关把响应缓冲起来，那么前导文本和全部音频会在合成结束之后一起到达；"
        "如果缓冲是关的，前导会立刻到，音频随后一小段一小段地持续吐出来。"
        "现在这段话一共一百多个字，合成需要几秒钟，足够看出区别。"
        "为了把时间拉开，这里再补一段话：语音合成是按窗口滚动生成的，"
        "每生成一小段就写进同一条流，所以只要网关不缓冲，客户端就能一边收一边播，"
        "首字节延迟取决于第一个窗口的生成时间，而不是整段文字的总生成时间。"
        "如果看到前导和音频同时到达、而且到达时间等于总合成时间，那就说明中间有东西在攒数据。"
        "反过来，如果前导几十毫秒就到、音频在随后几秒里持续增加，就说明这条链路是通的。"
    )
    # 用全新的 brain_id，免得上一轮被打断时的残留消息排在前面
    c = Conn(HOST, insecure)
    st, res = c.request_json("POST", "/agent-to-brain", HOST,
                             {"brain_id": LONG_BRAIN_ID, "text": long_text})
    c.close()
    print(f"[agent-to-brain 长回复] {st} -> {res}（{len(long_text)} 字）")

    for attempt in range(3):
        c = Conn(HOST, insecure)
        r2 = stream_preamble(c, LONG_BRAIN_ID)
        c.close()
        if r2["text"]:
            break
        print(f"  （第 {attempt + 1} 次拿到空回复，重试）")
    print(f"[brain-to-human 长回复] {r2['status']} content-type={r2['content_type']}")
    print(f"  前导文本  = {(r2['text'] or '')[:40]!r}…")
    print_timeline(r2)
    ok &= r2["audio_head"] == b"OggS" and r2["t_preamble"] is not None
    # 音频在「前导之后」还在持续到达，且前导明显早于最后一段
    ok &= r2["audio_bytes"] > 4096
    ok &= r2["t_preamble"] < r2["elapsed"] - 0.5
    ok &= r2["timeline"][-1][1] > r2["timeline"][0][1]

    print("\n结论：" + ("全部通过" if ok else "有失败项，见上面"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
