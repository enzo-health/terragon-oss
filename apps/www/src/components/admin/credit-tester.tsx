"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  topUpUserCredits,
  forceCreditAutoReload,
} from "@/server-actions/admin/user";
import { Loader2 } from "lucide-react";
import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { toast } from "sonner";
import { useUserCreditBalanceQuery } from "@/queries/user-credit-balance-queries";

export function CreditTesterContent() {
  const [amountCents, setAmountCents] = useState("1000");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoReloadLoading, setAutoReloadLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = useAtomValue(userAtom);

  const { data: balance, refetch: refetchBalance } =
    useUserCreditBalanceQuery();

  const handleAdjustCredits = async () => {
    const amount = Number(amountCents);
    if (!Number.isFinite(amount)) {
      setError("Amount must be a valid number");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await topUpUserCredits({
        userId: user?.id!,
        amountCents: amount,
        description: description.trim() || undefined,
      });
      setSuccess(`Successfully adjusted credits by ${formatCents(amount)}`);
      // Refresh balance
      await refetchBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to adjust credits");
    } finally {
      setLoading(false);
    }
  };

  const formatCents = (cents: number) => {
    const dollars = cents / 100;
    const sign = cents >= 0 ? "" : "-";
    const absolute = Math.abs(dollars);
    return `${sign}$${absolute.toFixed(2)}`;
  };

  const handleTriggerAutoReload = async () => {
    setAutoReloadLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await forceCreditAutoReload();
      toast.success("Auto reload triggered successfully");
      await refetchBalance();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to trigger auto reload";
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setAutoReloadLoading(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Credit Balance Tester
        </h1>
        <p className="text-muted-foreground text-sm">
          Admin tool to view and manipulate your own credit balances using
          admin_adjustment grants.
        </p>
      </div>

      <div className="space-y-2 rounded-[1.25rem] border border-hairline p-6 bg-card">
        {!balance ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Total Credits
              </span>
              <span className="font-mono tabular-nums">
                {formatCents(balance.totalCreditsCents)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Usage</span>
              <span className="font-mono tabular-nums">
                {formatCents(balance.totalUsageCents)}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-3">
              <span className="font-medium">Balance</span>
              <span
                className={`text-lg font-semibold font-mono tabular-nums ${
                  balance.balanceCents < 0 ? "text-error" : "text-success"
                }`}
              >
                {formatCents(balance.balanceCents)}
              </span>
            </div>
          </>
        )}
      </div>

      <section className="space-y-4 border-t border-hairline pt-6">
        <div>
          <h2 className="text-base font-semibold">Adjust Credits</h2>
          <p className="text-sm text-muted-foreground">
            Add or remove credits using admin_adjustment grant type (use
            negative values to deduct).
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="amount">Amount (cents)</Label>
          <Input
            id="amount"
            type="number"
            placeholder="1000 = $10.00"
            value={amountCents}
            onChange={(e) => setAmountCents(e.target.value)}
            className="font-mono tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            Enter a positive number to add credits, negative to deduct.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="description">Description (optional)</Label>
          <Textarea
            id="description"
            placeholder="Reason for adjustment..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>

        <Button
          onClick={handleAdjustCredits}
          disabled={loading || !amountCents}
          className="w-full rounded-full"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing...
            </>
          ) : (
            "Adjust Credits"
          )}
        </Button>
      </section>

      <section className="space-y-3 border-t border-hairline pt-6">
        <h2 className="text-base font-semibold">Force Credit Auto Reload</h2>
        <Button
          onClick={handleTriggerAutoReload}
          disabled={autoReloadLoading}
          className="w-full rounded-full"
          variant="outline"
        >
          {autoReloadLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Triggering...
            </>
          ) : (
            "Trigger Auto Reload"
          )}
        </Button>
      </section>

      {error && (
        <p
          role="alert"
          className="text-sm text-error rounded-xl border border-error/30 bg-error/5 px-4 py-3"
        >
          {error}
        </p>
      )}

      {success && (
        <p
          role="status"
          className="text-sm text-success rounded-xl border border-success/30 bg-success/5 px-4 py-3"
        >
          {success}
        </p>
      )}
    </div>
  );
}
