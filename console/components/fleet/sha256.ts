// Incremental SHA-256. Fixed working storage keeps large browser files out of memory.
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private pending = new Uint8Array(64);
  private words = new Uint32Array(64);
  private used = 0;
  private length = 0;
  private finished = false;

  update(data: Uint8Array) {
    if (this.finished) throw new Error("Hash is already finalized");
    this.length += data.length;
    let offset = 0;
    if (this.used) {
      const n = Math.min(64 - this.used, data.length);
      this.pending.set(data.subarray(0, n), this.used); this.used += n; offset += n;
      if (this.used === 64) { this.compress(this.pending, 0); this.used = 0; }
    }
    while (offset + 64 <= data.length) { this.compress(data, offset); offset += 64; }
    if (offset < data.length) { this.pending.set(data.subarray(offset), 0); this.used = data.length - offset; }
    return this;
  }

  private compress(data: Uint8Array, offset: number) {
    const w = this.words;
    for (let i = 0; i < 16; i++) { const p = offset + i * 4; w[i] = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; }
    for (let i = 16; i < 64; i++) { const x = w[i-15], y = w[i-2]; const s0 = rotate(x,7)^rotate(x,18)^(x>>>3), s1 = rotate(y,17)^rotate(y,19)^(y>>>10); w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0; }
    let a=this.h[0],b=this.h[1],c=this.h[2],d=this.h[3],e=this.h[4],f=this.h[5],g=this.h[6],h=this.h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e,6)^rotate(e,11)^rotate(e,25), ch = (e&f)^(~e&g);
      const t1 = (h+s1+ch+K[i]+w[i])>>>0, s0=rotate(a,2)^rotate(a,13)^rotate(a,22), maj=(a&b)^(a&c)^(b&c), t2=(s0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    this.h[0]=(this.h[0]+a)>>>0;this.h[1]=(this.h[1]+b)>>>0;this.h[2]=(this.h[2]+c)>>>0;this.h[3]=(this.h[3]+d)>>>0;this.h[4]=(this.h[4]+e)>>>0;this.h[5]=(this.h[5]+f)>>>0;this.h[6]=(this.h[6]+g)>>>0;this.h[7]=(this.h[7]+h)>>>0;
  }

  digest() {
    if (this.finished) throw new Error("Hash is already finalized");
    const bitLength = this.length * 8;
    this.pending[this.used++] = 0x80;
    if (this.used > 56) { this.pending.fill(0, this.used); this.compress(this.pending, 0); this.used = 0; }
    this.pending.fill(0, this.used, 56);
    const view = new DataView(this.pending.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false); view.setUint32(60, bitLength >>> 0, false);
    this.compress(this.pending, 0); this.finished = true;
    return Array.from(this.h, n => n.toString(16).padStart(8, "0")).join("");
  }
}

export async function hashFile(file: Blob, progress: (bytes: number) => void) {
  const hash = new Sha256();
  const chunkSize = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, file.size);
    hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    progress(end);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return hash.digest();
}
