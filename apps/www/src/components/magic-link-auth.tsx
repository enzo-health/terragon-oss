"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { Mail, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function MagicLinkAuth() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    try {
      await authClient.signIn.magicLink({
        email,
        callbackURL: "/dashboard",
      });
      setSent(true);
    } catch (error) {
      console.error("Failed to send magic link:", error);
      toast.error("Failed to send magic link. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="w-full text-center">
        <div className="rounded-full bg-coral/10 p-3 w-fit mx-auto mb-4">
          <Mail className="size-6 text-coral" />
        </div>
        <h3 className="text-lg font-semibold mb-2">Check your email</h3>
        <p className="text-sm text-mid mb-4">
          We sent a magic link to{" "}
          <strong className="text-strong">{email}</strong>
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
        >
          Try another email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full space-y-4">
      <div className="space-y-2">
        <Input
          type="email"
          placeholder="Enter your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          required
          className="w-full"
        />
      </div>
      <Button type="submit" disabled={loading || !email} className="w-full">
        {loading ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Sending…
          </>
        ) : (
          <>
            Continue with email
            <ArrowRight className="size-4" />
          </>
        )}
      </Button>
    </form>
  );
}

export function MagicLinkSignInButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Mail className="size-4" />
          Sign in with email
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with email</DialogTitle>
          <DialogDescription>
            Enter your email address and we’ll send you a magic link to sign in.
          </DialogDescription>
        </DialogHeader>
        <div className="px-1">
          <MagicLinkAuth />
        </div>
      </DialogContent>
    </Dialog>
  );
}
