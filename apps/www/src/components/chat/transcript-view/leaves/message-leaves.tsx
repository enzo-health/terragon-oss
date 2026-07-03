"use client";

import { useEffect, useState } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStepStatic,
  ChainOfThoughtIcon,
} from "@/components/ai/chain-of-thought";
import { Message, MessageContent, MessageText } from "@/components/ai/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai/reasoning";
import { cn } from "@/lib/utils";
import { ImagePart } from "../../image-part";
import { TextPart } from "../../text-part";
import type { Leaf } from "../leaf-props";
import { useIsSeeded } from "../seeded-context";

export const TextLeaf: Leaf<"text"> = ({ item }) => {
  const seeded = useIsSeeded(item.key);
  return (
    <Message
      type="incoming"
      className={cn(
        !seeded &&
          "animate-in fade-in duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] motion-reduce:animate-none",
      )}
    >
      <MessageContent className="break-words text-sm leading-relaxed">
        <MessageText variant="plain">
          <TextPart text={item.text} streaming={item.streaming} />
        </MessageText>
      </MessageContent>
    </Message>
  );
};

export const ReasoningLeaf: Leaf<"reasoning"> = ({ item }) => {
  const [open, setOpen] = useState(item.streaming);

  useEffect(() => {
    if (!item.streaming) setOpen(false);
  }, [item.streaming]);

  if (item.steps.length > 0) {
    return (
      <ChainOfThought
        className="my-2"
        open={open}
        onOpenChange={setOpen}
        defaultOpen={item.streaming}
      >
        <ChainOfThoughtHeader>Thinking</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {item.steps.map((step, index) => (
            <ChainOfThoughtStepStatic key={index}>
              <ChainOfThoughtIcon />
              <TextPart text={step.text} />
            </ChainOfThoughtStepStatic>
          ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
    );
  }

  return (
    <Reasoning className="my-2" open={open} onOpenChange={setOpen}>
      <ReasoningTrigger>Thinking</ReasoningTrigger>
      <ReasoningContent keepMounted>
        <TextPart text={item.text} streaming={item.streaming} />
      </ReasoningContent>
    </Reasoning>
  );
};

export const UserLeaf: Leaf<"user"> = ({ item }) => {
  const seeded = useIsSeeded(item.key);
  return (
    <Message
      type="outgoing"
      className={cn(
        "mt-4 py-2 sm:mt-6",
        !seeded &&
          "animate-in fade-in slide-in-from-bottom-2 duration-[var(--duration-base)] ease-[var(--ease-emphasis)] motion-reduce:animate-none",
      )}
    >
      <MessageContent>
        <MessageText
          variant="bubble"
          className="max-w-[90%] rounded-[calc(var(--radius)+0.15rem)] bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-warm-lift)] ring-0 sm:max-w-[85%]"
        >
          {item.content.map((part, index) => {
            if (part.type === "text") {
              return <TextPart key={index} text={part.text} />;
            }
            if (part.type === "image" && part.url) {
              return <ImagePart key={index} imageUrl={part.url} />;
            }
            return null;
          })}
        </MessageText>
      </MessageContent>
    </Message>
  );
};
