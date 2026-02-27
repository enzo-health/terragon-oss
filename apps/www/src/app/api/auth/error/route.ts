import { redirect } from "next/navigation";

// Don't show the built-in better-auth error page.
export async function GET(request: Request) {
  // Redirect to the login page with error query param
  const searchParams = new URL(request.url).searchParams;
  const error = searchParams.get("error");
  redirect(`/login?error=${error}`);
}
