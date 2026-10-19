import sys, struct, zlib
def pack(data: bytes, out: str, width=2048):
    payload = struct.pack('>I', len(data)) + data
    h = (len(payload) + width - 1) // width
    payload += b'\0' * (h * width - len(payload))
    raw = b''.join(b'\0' + payload[i*width:(i+1)*width] for i in range(h))
    # zlib stream of stored blocks
    z = bytearray(b'\x78\x01')
    for i in range(0, len(raw), 65535):
        blk = raw[i:i+65535]; last = 1 if i + 65535 >= len(raw) else 0
        z += bytes([last]) + struct.pack('<HH', len(blk), 0xFFFF ^ len(blk)) + blk
    z += struct.pack('>I', zlib.adler32(raw) & 0xffffffff)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, h, 8, 0, 0, 0, 0)) + chunk(b'IDAT', bytes(z)) + chunk(b'IEND', b'')
    open(out, 'wb').write(png); return h
if __name__ == '__main__':
    print(pack(open(sys.argv[1], 'rb').read(), sys.argv[2]))
