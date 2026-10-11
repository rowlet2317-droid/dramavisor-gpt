export type RemoteMediaStream = object;

export interface RemoteAudioSink {
  attach(stream: RemoteMediaStream): void | Promise<void>;
  close(): void | Promise<void>;
}

type AudioElementLike = {
  autoplay: boolean;
  srcObject: unknown;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
};

export class BrowserRemoteAudioSink implements RemoteAudioSink {
  private element: AudioElementLike | null = null;

  constructor(private readonly createAudio: () => AudioElementLike = () => {
    const element = document.createElement("audio");
    document.body.append(element);
    return element;
  }, private readonly onAttach: (stream: RemoteMediaStream) => void = () => undefined) {}

  async attach(stream: RemoteMediaStream): Promise<void> {
    const element = this.element ?? this.createAudio();
    this.element = element;
    element.autoplay = true;
    element.srcObject = stream;
    this.onAttach(stream);
    await element.play();
  }

  close(): void {
    if (!this.element) return;
    this.element.pause();
    this.element.srcObject = null;
    this.element.remove();
    this.element = null;
  }
}
