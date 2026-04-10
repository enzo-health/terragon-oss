import { source } from "@/lib/source";
import {
  DocsPage,
  DocsBody,
  DocsDescription,
  DocsTitle,
} from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { getMDXComponents } from "@/mdx-components";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDXContent = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const slug = params.slug?.join("/") || "";
  const url = slug
    ? `https://docs.terragonlabs.com/docs/${slug}`
    : "https://docs.terragonlabs.com/docs";

  return {
    title: page.data.title,
    description:
      page.data.description ||
      `Learn about ${page.data.title} in Leo documentation`,
    openGraph: {
      title: page.data.title,
      description:
        page.data.description ||
        `Learn about ${page.data.title} in Leo documentation`,
      url,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description:
        page.data.description ||
        `Learn about ${page.data.title} in Leo documentation`,
    },
    alternates: {
      canonical: url,
    },
  };
}
