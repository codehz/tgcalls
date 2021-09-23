import { EventEmitter } from "events";
import { Readable } from "stream";
import { nonstandard, RTCAudioData, RTCVideoFrame } from "wrtc";
import { Chunked } from "./chunked";
import { StreamAudioOptions, StreamOptions, StreamVideoOptions } from "./types";
import { Interval, TimerState } from "date-timeout-interval";

export declare interface MediaStream<O> {
  on(event: "pause", listener: (paused: boolean) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "finish", listener: () => void): this;
  on(event: "almost-finished", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: Function): this;
}

interface BaseStreamConfig extends StreamOptions {
  readable: Readable;
  chunksize: number;
  cps: number;
}

export abstract class MediaStream<O> extends EventEmitter {
  #cache?: Chunked;
  #timer?: Interval;
  readonly #callback: () => void;
  constructor(onFrame: (chunk: Uint8Array) => void) {
    super();

    this.#callback = () => {
      if (!this.#cache) return;
      const frame = this.#cache.latest;
      if (frame) {
        onFrame(frame);
        if (this.#cache.finished) {
          this.#timer?.stop();
          this.emit("finish");
        }
      }
    };
  }

  abstract update(
    readable: Readable,
    options: StreamOptions & O,
  ): Promise<void>;

  protected _update(
    {
      readable,
      buffer,
      maxbuffer,
      chunksize,
      cps,
    }: BaseStreamConfig,
  ): Promise<void> {
    let resolver: undefined | ((err?: Error) => void);

    if (this.#cache) {
      this.#cache.destroy();
    }
    this.#cache = new Chunked(
      readable,
      chunksize,
      buffer * cps,
      maxbuffer * cps,
    );
    this.#cache.on("ready", () => {
      resolver?.();
      this.emit("ready");
    });
    this.#cache.on("almost-finished", () => this.emit("almost-finished"));
    this.#cache.on("error", (e) => {
      resolver?.(e);
      this.#timer?.stop();
      this.emit("error", e);
    });
    this.#timer = new Interval(this.#callback, 1000 / cps);

    return new Promise((resolve, reject) => {
      resolver = (e) => {
        if (e) reject(e);
        else resolve();
        resolver = undefined;
      };
    });
  }

  get paused() {
    return this.#timer?.state == TimerState.Paused;
  }

  get playing() {
    return this.#timer?.state == TimerState.Running;
  }

  stop() {
    if (this.#timer && this.#cache) {
      this.#timer.stop();
      this.#timer = undefined;
      this.#cache.destroy();
      this.#cache = undefined;
      this.emit("finish");
    }
  }

  get finished() {
    return this.#cache?.finished ?? true;
  }

  pause() {
    if (this.#timer && this.#timer.state == TimerState.Running) {
      this.#timer?.pause();
      this.emit("pause", true);
    }
  }

  resume() {
    if (this.#timer && this.#timer.state != TimerState.Done) {
      this.#timer.start();
      this.emit("pause", false);
    }
  }

  abstract createTrack(): MediaStreamTrack;
}

export class AudioStream extends MediaStream<StreamAudioOptions> {
  readonly #source = new nonstandard.RTCAudioSource();
  #template?: Omit<RTCAudioData, "samples">;

  constructor() {
    super(
      (data: Uint8Array) => {
        const samples = new Int16Array(data.buffer);
        this.#source.onData(Object.assign({
          samples,
        }, this.#template));
      },
    );
  }

  override update(
    readable: Readable,
    { buffer, maxbuffer, bitsPerSample, sampleRate, channelCount }:
      & StreamOptions
      & StreamAudioOptions,
  ) {
    const cps = 100;
    const chunksize = bitsPerSample * sampleRate / 8 / cps * channelCount;
    this.#template = {
      sampleRate,
      bitsPerSample,
      channelCount,
    };
    return super._update({
      readable,
      buffer,
      maxbuffer,
      chunksize,
      cps,
    });
  }
  createTrack(): MediaStreamTrack {
    return this.#source.createTrack();
  }
}

export class VideoStream extends MediaStream<StreamVideoOptions> {
  readonly #source = new nonstandard.RTCVideoSource();
  #template?: Omit<RTCVideoFrame, "data">;

  constructor() {
    super(
      (data: Uint8Array) => {
        this.#source.onFrame(Object.assign({
          data: new Uint8ClampedArray(data.buffer),
        }, this.#template));
      },
    );
  }

  override update(
    readable: Readable,
    { buffer, maxbuffer, framerate, width, height }:
      & StreamOptions
      & StreamVideoOptions,
  ) {
    const cps = framerate;
    const uv_rowbytes = (width + 1) / 2 | 0;
    const half_height = (height + 1) / 2 | 0;
    const uv_size = uv_rowbytes * half_height;
    const chunksize = width * height + uv_size * 2; // YUV420
    this.#template = { width, height };
    return super._update({
      readable,
      buffer,
      maxbuffer,
      chunksize,
      cps,
    });
  }
  createTrack(): MediaStreamTrack {
    return this.#source.createTrack();
  }
}
