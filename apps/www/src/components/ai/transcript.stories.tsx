import type { Story, StoryDefault } from "@ladle/react";
import { Player, PlayerAudio } from "./player";
import {
  Transcript,
  TranscriptContent,
  TranscriptItem,
  TranscriptList,
  TranscriptSpeaker,
  TranscriptText,
  TranscriptTime,
  TranscriptWord,
} from "./transcript";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Conversation: Story = () => (
  <Surface>
    <div className="max-w-lg">
      <Player>
        <PlayerAudio />
        <Transcript className="max-h-96">
          <TranscriptContent>
            <TranscriptList>
              <TranscriptItem start={0} end={6}>
                <TranscriptTime />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <TranscriptSpeaker>Ada</TranscriptSpeaker>
                  <TranscriptText>
                    Let&apos;s walk through the resume path before we ship the
                    fence change.
                  </TranscriptText>
                </div>
              </TranscriptItem>
              <TranscriptItem start={6} end={14}>
                <TranscriptTime />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <TranscriptSpeaker>Grace</TranscriptSpeaker>
                  <TranscriptText>
                    Right — the SSE echo can&apos;t be the only completion
                    signal, so we read the POST response too.
                  </TranscriptText>
                </div>
              </TranscriptItem>
              <TranscriptItem start={14} end={20}>
                <TranscriptTime />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <TranscriptSpeaker>Ada</TranscriptSpeaker>
                  <TranscriptText>
                    Agreed. I&apos;ll add a replay test that drops the echo
                    mid-turn.
                  </TranscriptText>
                </div>
              </TranscriptItem>
            </TranscriptList>
          </TranscriptContent>
        </Transcript>
      </Player>
    </div>
  </Surface>
);

export const WordLevel: Story = () => (
  <Surface>
    <div className="max-w-lg">
      <Player>
        <PlayerAudio />
        <Transcript>
          <TranscriptContent>
            <TranscriptList>
              <TranscriptItem start={0} end={5}>
                <TranscriptTime />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <TranscriptSpeaker>Narrator</TranscriptSpeaker>
                  <TranscriptText>
                    <TranscriptWord start={0} end={0.6}>
                      The{" "}
                    </TranscriptWord>
                    <TranscriptWord start={0.6} end={1.2}>
                      transcript{" "}
                    </TranscriptWord>
                    <TranscriptWord start={1.2} end={1.8}>
                      highlights{" "}
                    </TranscriptWord>
                    <TranscriptWord start={1.8} end={2.4}>
                      each{" "}
                    </TranscriptWord>
                    <TranscriptWord start={2.4} end={3}>
                      word{" "}
                    </TranscriptWord>
                    <TranscriptWord start={3} end={3.8}>
                      as{" "}
                    </TranscriptWord>
                    <TranscriptWord start={3.8} end={5}>
                      playback advances.
                    </TranscriptWord>
                  </TranscriptText>
                </div>
              </TranscriptItem>
            </TranscriptList>
          </TranscriptContent>
        </Transcript>
      </Player>
    </div>
  </Surface>
);

export const InterimText: Story = () => (
  <Surface>
    <div className="max-w-lg">
      <Player>
        <PlayerAudio />
        <Transcript>
          <TranscriptContent>
            <TranscriptList>
              <TranscriptItem start={0} end={4}>
                <TranscriptTime />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <TranscriptSpeaker>Grace</TranscriptSpeaker>
                  <TranscriptText>
                    The final PR description is ready for review.
                  </TranscriptText>
                </div>
              </TranscriptItem>
              <TranscriptItem start={4}>
                <TranscriptTime />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <TranscriptSpeaker>Grace</TranscriptSpeaker>
                  <TranscriptText interim>
                    and I think the next step is to…
                  </TranscriptText>
                </div>
              </TranscriptItem>
            </TranscriptList>
          </TranscriptContent>
        </Transcript>
      </Player>
    </div>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <div className="max-w-lg">
      <Player>
        <PlayerAudio />
        <Transcript>
          <TranscriptContent>
            <TranscriptList>
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No transcript yet.
              </div>
            </TranscriptList>
          </TranscriptContent>
        </Transcript>
      </Player>
    </div>
  </Surface>
);

export const LongScroll: Story = () => (
  <Surface>
    <div className="max-w-lg">
      <Player>
        <PlayerAudio />
        <Transcript className="max-h-80">
          <TranscriptContent>
            <TranscriptList>
              {Array.from({ length: 24 }, (_, i) => (
                <TranscriptItem key={i} start={i * 5} end={i * 5 + 5}>
                  <TranscriptTime />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <TranscriptSpeaker>
                      {i % 2 === 0 ? "Ada" : "Grace"}
                    </TranscriptSpeaker>
                    <TranscriptText>
                      Turn {i + 1}: we keep the seq-cursor replay stack because
                      HttpAgent has no native resume.
                    </TranscriptText>
                  </div>
                </TranscriptItem>
              ))}
            </TranscriptList>
          </TranscriptContent>
        </Transcript>
      </Player>
    </div>
  </Surface>
);

export default {
  title: "ai/transcript",
} satisfies StoryDefault;
