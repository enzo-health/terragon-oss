import type { Story, StoryDefault } from "@ladle/react";
import {
  Player,
  PlayerAudio,
  PlayerCurrentTime,
  PlayerDuration,
  PlayerMeta,
  PlayerMute,
  PlayerPlayPause,
  PlayerProgress,
  PlayerSeekButton,
  PlayerTitle,
  PlayerVideo,
  PlayerVolume,
  PlayerWaveform,
} from "./player";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
  </svg>
);

const Back10Icon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 8 7 12l4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M7 12h6a4 4 0 1 1 0 8h-1" strokeLinecap="round" />
  </svg>
);

const Fwd10Icon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m13 8 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M17 12h-6a4 4 0 1 0 0 8h1" strokeLinecap="round" />
  </svg>
);

const VolumeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" strokeLinejoin="round" />
    <path d="M16 9a4 4 0 0 1 0 6" strokeLinecap="round" />
  </svg>
);

const MutedIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" strokeLinejoin="round" />
    <path d="m17 9 4 6m0-6-4 6" strokeLinecap="round" />
  </svg>
);

const PEAKS = Array.from({ length: 96 }, (_, i) => {
  const envelope = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.13 + 0.6));
  const detail = Math.abs(Math.sin(i * 0.9)) * 0.55 + 0.2;
  return Math.min(1, envelope * detail + 0.08);
});

const TONE_SRC = (() => {
  if (typeof window === "undefined" || typeof btoa === "undefined") return "";
  const sampleRate = 8000;
  const seconds = 6;
  const total = sampleRate * seconds;
  const bytes = new Uint8Array(44 + total);
  const view = new DataView(bytes.buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + total, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, "data");
  view.setUint32(40, total, true);
  for (let i = 0; i < total; i++) {
    const tone = Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    bytes[44 + i] = 128 + Math.round(tone * 60);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return `data:audio/wav;base64,${btoa(binary)}`;
})();

const cardClass =
  "flex flex-col gap-3 rounded-outer bg-surface ring ring-border p-4";
const transportButton =
  "inline-flex size-9 items-center justify-center rounded-full text-foreground hover:bg-surface-elevated";
const primaryButton =
  "inline-flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90";

export const AudioPlayer: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Player>
        <div className={cardClass}>
          <div>
            <PlayerTitle>Standup recap · engineering</PlayerTitle>
            <PlayerMeta>Recorded 2026-07-02 · 12 min</PlayerMeta>
          </div>
          <PlayerWaveform peaks={PEAKS} />
          <div className="flex items-center gap-2">
            <PlayerCurrentTime />
            <PlayerSeekButton seek={-10} className={transportButton}>
              <Back10Icon />
            </PlayerSeekButton>
            <PlayerPlayPause
              className={primaryButton}
              playIcon={<PlayIcon />}
              pauseIcon={<PauseIcon />}
            />
            <PlayerSeekButton seek={10} className={transportButton}>
              <Fwd10Icon />
            </PlayerSeekButton>
            <PlayerDuration />
            <div className="ml-auto flex items-center gap-2">
              <PlayerMute
                className={transportButton}
                unmuteIcon={<VolumeIcon />}
                muteIcon={<MutedIcon />}
              />
              <PlayerVolume />
            </div>
          </div>
          <PlayerAudio src={TONE_SRC} />
        </div>
      </Player>
    </div>
  </Surface>
);

export const WaveformLoading: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Player>
        <div className={cardClass}>
          <div>
            <PlayerTitle>Decoding audio…</PlayerTitle>
            <PlayerMeta>Reading peaks from source</PlayerMeta>
          </div>
          <PlayerWaveform />
          <div className="flex items-center gap-2">
            <PlayerCurrentTime />
            <PlayerPlayPause
              className={primaryButton}
              playIcon={<PlayIcon />}
              pauseIcon={<PauseIcon />}
            />
            <PlayerDuration />
          </div>
        </div>
      </Player>
    </div>
  </Surface>
);

export const Playing: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Player>
        <div className={cardClass}>
          <div>
            <PlayerTitle>Now playing · muted preview</PlayerTitle>
            <PlayerMeta>Autoplays muted where the browser allows</PlayerMeta>
          </div>
          <PlayerWaveform peaks={PEAKS} />
          <div className="flex items-center gap-2">
            <PlayerCurrentTime />
            <PlayerPlayPause
              className={primaryButton}
              playIcon={<PlayIcon />}
              pauseIcon={<PauseIcon />}
            />
            <PlayerProgress />
            <PlayerDuration />
          </div>
          <PlayerAudio src={TONE_SRC} autoPlay muted loop />
        </div>
      </Player>
    </div>
  </Surface>
);

export const ProgressBar: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Player>
        <div className={cardClass}>
          <PlayerTitle>Compact transport</PlayerTitle>
          <PlayerProgress />
          <div className="flex items-center gap-2">
            <PlayerPlayPause
              className={transportButton}
              playIcon={<PlayIcon />}
              pauseIcon={<PauseIcon />}
            />
            <PlayerCurrentTime />
            <span className="text-xs text-muted-foreground">/</span>
            <PlayerDuration />
            <div className="ml-auto flex items-center gap-2">
              <PlayerMute
                className={transportButton}
                unmuteIcon={<VolumeIcon />}
                muteIcon={<MutedIcon />}
              />
              <PlayerVolume />
            </div>
          </div>
          <PlayerAudio src={TONE_SRC} />
        </div>
      </Player>
    </div>
  </Surface>
);

export const VideoPlayer: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Player>
        <div className="overflow-hidden rounded-outer ring ring-border">
          <PlayerVideo src="https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" />
          <div className="flex items-center gap-2 bg-surface p-3">
            <PlayerPlayPause
              className={transportButton}
              playIcon={<PlayIcon />}
              pauseIcon={<PauseIcon />}
            />
            <PlayerCurrentTime />
            <PlayerProgress />
            <PlayerDuration />
          </div>
        </div>
      </Player>
    </div>
  </Surface>
);

export default {
  title: "ai/player",
} satisfies StoryDefault;
