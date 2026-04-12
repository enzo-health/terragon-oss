import { getUserIdOrRedirect } from "@/lib/auth-server";
import { getReviewDetail } from "@/server-actions/review-detail";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ReviewDetailView } from "@/components/review/review-detail-view";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}): Promise<Metadata> {
  const { reviewId } = await params;
  const result = await getReviewDetail(reviewId);
  if (!result.success || !result.data) {
    return { title: "Review | Terragon" };
  }
  return {
    title: `Review: ${result.data.prTitle} | Terragon`,
  };
}

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  await getUserIdOrRedirect();
  const { reviewId } = await params;
  const result = await getReviewDetail(reviewId);

  if (!result.success || !result.data) {
    return notFound();
  }

  return <ReviewDetailView review={result.data} />;
}
