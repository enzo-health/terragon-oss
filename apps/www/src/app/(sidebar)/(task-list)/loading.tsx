import { PageLoader } from "@/components/shared/page-loader";
import { ChatUISkeleton } from "@/components/chat/chat-ui-skeleton";

export default function Loading() {
  return (
    <>
      <PageLoader />
      <ChatUISkeleton />
    </>
  );
}
