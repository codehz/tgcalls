import { EventEmitter, Readable } from "stream";

function* chunked(
  source: Uint8Array,
  itemsize: number,
): Generator<Uint8Array> {
  let pos = 0;
  while (source.length - pos >= itemsize) {
    yield source.slice(pos, pos + itemsize);
    pos += itemsize;
  }
  if (source.length > pos) {
    yield source.slice(pos);
  }
}
export declare interface Chunked {
  on(event: "ready", listener: (remain: number) => void): this;
  on(event: "almost-finished", listener: (remain: number) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "finish", listener: () => void): this;
  on(event: string, listener: Function): this;
}

export class Chunked extends EventEmitter {
  readonly readable: Readable;
  readonly itemsize: number;
  readonly minbuffer: number;
  readonly maxbuffer: number;
  #finished: boolean = false;
  #ready: boolean = false;
  #data: Uint8Array[] = [];
  #remain: number = 0;

  get #last() {
    return this.#data[this.#data.length - 1];
  }

  get finished() {
    return this.#finished && this.#data.length == 0;
  }

  private set ready(flag: boolean) {
    if (this.#finished) flag = true;
    if (flag == this.#ready) return;
    this.#ready = flag;
    if (flag) {
      this.emit("ready", this.remain);
    } else {
      this.emit("almost-finished", this.remain);
    }
  }

  get ready() {
    return this.#ready;
  }

  constructor(
    readable: Readable,
    itemsize: number,
    minbuffer: number,
    maxbuffer: number,
  ) {
    super();
    this.readable = readable;
    this.itemsize = itemsize;
    this.minbuffer = minbuffer;
    this.maxbuffer = maxbuffer;

    readable.on("data", (data: Uint8Array) => {
      if (this.#remain > 0) {
        const tmp = data.slice(0, this.#remain);
        this.#last.set(tmp, itemsize - this.#remain);
        this.#remain -= tmp.length;
        data = data.slice(this.#remain);
        if (this.#remain > 0) return;
      }
      for (const chunk of chunked(data, itemsize)) {
        const tmp = new Uint8Array(itemsize);
        tmp.set(chunk);
        this.#data.push(tmp);
        this.#remain = itemsize - chunk.length;
      }
      if (this.remain > maxbuffer) {
        readable.pause();
      } else {
        this.ready = this.remain >= this.minbuffer;
      }
    });

    readable.on("end", () => {
      this.#finished = true;
      this.ready = true;
    });

    readable.on("error", (e) => {
      this.#finished = true;
      this.ready = true;
      this.emit("error", e);
    });
  }

  get remain() {
    return this.#data.length - (this.#remain > 0 ? 1 : 0);
  }

  get latest() {
    const ret = this.#data.shift();
    if (this.readable.isPaused()) {
      if (this.remain < this.maxbuffer) {
        this.readable.resume();
      }
    } else {
      this.ready = this.remain >= this.minbuffer;
    }
    return ret;
  }

  destroy() {
    this.#finished = true;
    this.readable.destroy();
  }
}
