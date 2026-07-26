import { EventEmitter } from "node:events";
import wrtc from "@roamhq/wrtc";
import type { Logger } from "../logger.js";

const TARGET_SAMPLE_RATE = 24_000;
const WEBRTC_INPUT_SAMPLE_RATE = 48_000;
const WEBRTC_INPUT_FRAME_MS = 10;
const WEBRTC_INPUT_SAMPLES = WEBRTC_INPUT_SAMPLE_RATE * WEBRTC_INPUT_FRAME_MS / 1_000;
const PCM24K_FRAME_SAMPLES = TARGET_SAMPLE_RATE * WEBRTC_INPUT_FRAME_MS / 1_000;

export interface WebRtcAudioFrame {
  pcm: Buffer;
  sampleRate: number;
  numChannels: number;
}

export class WebRtcAudioPeer extends EventEmitter {
  private readonly connection = new wrtc.RTCPeerConnection();
  private readonly source = new wrtc.nonstandard.RTCAudioSource();
  private readonly inputTrack = this.source.createTrack();
  private readonly silenceSamples = new Int16Array(WEBRTC_INPUT_SAMPLES);
  private readonly silenceTimer: NodeJS.Timeout;
  private sink?: wrtc.nonstandard.RTCAudioSink;
  private sending = false;
  private closed = false;

  constructor(private readonly logger: Logger) {
    super();
    this.connection.addTrack(this.inputTrack);
    this.connection.createDataChannel("oai-events");
    this.connection.ontrack = (event) => this.attachOutputTrack(event.track);
    this.connection.onconnectionstatechange = () => {
      this.logger.debug(`GPT-Live WebRTC 状态: ${this.connection.connectionState}`);
      if (["failed", "closed"].includes(this.connection.connectionState)) {
        this.emit("closed", this.connection.connectionState);
      }
    };
    this.silenceTimer = setInterval(() => {
      if (!this.closed && !this.sending) this.pushInputFrame(this.silenceSamples);
    }, WEBRTC_INPUT_FRAME_MS);
    this.silenceTimer.unref();
  }

  async createOffer(): Promise<string> {
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await this.waitForIceGathering();
    const sdp = this.connection.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC 没有生成本地 SDP");
    return sdp;
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.connection.setRemoteDescription({ type: "answer", sdp });
    await this.waitForConnection();
  }

  async sendPcm24k(pcm: Buffer): Promise<void> {
    if (pcm.length % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("WebRTC 输入 PCM16 的字节数不是偶数");
    }
    if (this.sending) throw new Error("WebRTC 正在发送上一段音频");
    const sourceSamples = new Int16Array(pcm.byteLength / Int16Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < sourceSamples.length; index += 1) {
      sourceSamples[index] = pcm.readInt16LE(index * Int16Array.BYTES_PER_ELEMENT);
    }
    this.sending = true;
    try {
      const startedAt = Date.now();
      let frameIndex = 0;
      for (let offset = 0; offset < sourceSamples.length; offset += PCM24K_FRAME_SAMPLES) {
        if (this.closed) throw new Error("WebRTC 音频输入期间连接已关闭");
        const samples = new Int16Array(WEBRTC_INPUT_SAMPLES);
        const available = Math.min(PCM24K_FRAME_SAMPLES, sourceSamples.length - offset);
        for (let index = 0; index < available; index += 1) {
          const sample = sourceSamples[offset + index];
          samples[index * 2] = sample;
          samples[index * 2 + 1] = sample;
        }
        this.pushInputFrame(samples);
        frameIndex += 1;
        const delayMs = startedAt + frameIndex * WEBRTC_INPUT_FRAME_MS - Date.now();
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      this.sending = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.silenceTimer);
    this.removeAllListeners();
    this.sink?.stop();
    this.inputTrack.stop();
    this.connection.close();
  }

  private attachOutputTrack(track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;
    this.logger.debug("GPT-Live WebRTC 已收到远端音频轨道");
    this.sink?.stop();
    this.sink = new wrtc.nonstandard.RTCAudioSink(track);
    this.sink.ondata = (event: Event & { samples?: Int16Array; sampleRate?: number; channelCount?: number; numberOfFrames?: number }) => {
      if (!(event.samples instanceof Int16Array) || !event.sampleRate) return;
      const pcm = normalizeWebRtcAudio(
        event.samples,
        event.sampleRate,
        event.channelCount ?? 1,
        event.numberOfFrames,
      );
      if (pcm.length) {
        this.emit("audio", {
          pcm,
          sampleRate: TARGET_SAMPLE_RATE,
          numChannels: 1,
        } satisfies WebRtcAudioFrame);
      }
    };
  }

  private pushInputFrame(samples: Int16Array): void {
    this.source.onData({
      samples,
      sampleRate: WEBRTC_INPUT_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: WEBRTC_INPUT_SAMPLES,
    });
  }

  private async waitForIceGathering(): Promise<void> {
    if (this.connection.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.connection.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      };
      const timer = setTimeout(finish, 2_000);
      const onStateChange = () => {
        if (this.connection.iceGatheringState !== "complete") return;
        finish();
      };
      this.connection.addEventListener("icegatheringstatechange", onStateChange);
    });
  }

  private async waitForConnection(): Promise<void> {
    if (this.connection.connectionState === "connected") return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.connection.removeEventListener("connectionstatechange", onStateChange);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`WebRTC 媒体连接超时，当前状态 ${this.connection.connectionState}`)),
        12_000,
      );
      const onStateChange = () => {
        if (this.connection.connectionState === "connected") finish();
        if (["failed", "closed"].includes(this.connection.connectionState)) {
          finish(new Error(`WebRTC 媒体连接${this.connection.connectionState}`));
        }
      };
      this.connection.addEventListener("connectionstatechange", onStateChange);
    });
  }
}

export function normalizeWebRtcAudio(
  samples: Int16Array,
  sampleRate: number,
  numChannels: number,
  numberOfFrames?: number,
): Buffer {
  if (sampleRate <= 0 || numChannels <= 0) return Buffer.alloc(0);
  const availableFrames = Math.floor(samples.length / numChannels);
  const sourceFrames = Math.min(numberOfFrames ?? availableFrames, availableFrames);
  if (!sourceFrames) return Buffer.alloc(0);

  const mono = new Int16Array(sourceFrames);
  for (let frame = 0; frame < sourceFrames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < numChannels; channel += 1) {
      sum += samples[frame * numChannels + channel];
    }
    mono[frame] = Math.max(-32_768, Math.min(32_767, Math.round(sum / numChannels)));
  }

  if (sampleRate === TARGET_SAMPLE_RATE) {
    return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength);
  }

  const targetFrames = Math.max(1, Math.round(sourceFrames * TARGET_SAMPLE_RATE / sampleRate));
  const output = new Int16Array(targetFrames);
  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = frame * sampleRate / TARGET_SAMPLE_RATE;
    const left = Math.min(sourceFrames - 1, Math.floor(sourcePosition));
    const right = Math.min(sourceFrames - 1, left + 1);
    const fraction = sourcePosition - left;
    output[frame] = Math.round(mono[left] + (mono[right] - mono[left]) * fraction);
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}
