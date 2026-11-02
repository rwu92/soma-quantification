import struct, numpy as np
def read_pixels(path):
    with open(path, 'rb') as f: b = f.read()
    le = b[:2] == b'II'; E = '<' if le else '>'
    off = struct.unpack(E + 'I', b[4:8])[0]; n = struct.unpack(E + 'H', b[off:off + 2])[0]; tags = {}
    for i in range(n):
        o = off + 2 + i * 12; tag, typ, cnt = struct.unpack(E + 'HHI', b[o:o + 8])
        sz = {1: 1, 2: 1, 3: 2, 4: 4}.get(typ, 1); base = o + 8 if sz * cnt <= 4 else struct.unpack(E + 'I', b[o + 8:o + 12])[0]
        fmt = {3: 'H', 4: 'I'}.get(typ)
        tags[tag] = list(struct.unpack(E + fmt * cnt, b[base:base + sz * cnt])) if fmt and cnt < 100000 else (base, cnt)
    w, h, bits = tags[256][0], tags[257][0], tags[258][0]
    offs, cnts = tags[273], tags[279]
    raw = b''.join(b[o:o + c] for o, c in zip(offs, cnts))
    return np.frombuffer(raw, dtype=(E + 'u2') if bits == 16 else 'u1')[:w * h].reshape(h, w).astype(np.float32)
