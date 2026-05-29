"use client";

import { useReducer } from "react";
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

type CreditTesterState = {
  amountCents: string;
  description: string;
  loading: boolean;
  autoReloadLoading: boolean;
  success: string | null;
  error: string | null;
};

type CreditTesterAction =
  | { type: "set-amount-cents"; amountCents: string }
  | { type: "set-description"; description: string }
  | { type: "adjust-start" }
  | { type: "adjust-success"; success: string }
  | { type: "adjust-error"; error: string }
  | { type: "auto-reload-start" }
  | { type: "auto-reload-success" }
  | { type: "auto-reload-error"; error: string };

function creditTesterReducer(
  state: CreditTesterState,
  action: CreditTesterAction,
): CreditTesterState {
  switch (action.type) {
    case "set-amount-cents":
      return { ...state, amountCents: action.amountCents };
    case "set-description":
      return { ...state, description: action.description };
    case "adjust-start":
      return { ...state, loading: true, error: null, success: null };
    case "adjust-success":
      return {
        ...state,
        loading: false,
        success: action.success,
      };
    case "adjust-error":
      return { ...state, loading: false, error: action.error };
    case "auto-reload-start":
      return { ...state, autoReloadLoading: true, error: null, success: null };
    case "auto-reload-success":
      return { ...state, autoReloadLoading: false };
    case "auto-reload-error":
      return {
        ...state,
        autoReloadLoading: false,
        error: action.error,
      };
  }
}

export function CreditTesterContent() {
  const [state, dispatch] = useReducer(creditTesterReducer, {
    amountCents: "1000",
    description: "",
    loading: false,
    autoReloadLoading: false,
    success: null,
    error: null,
  });
  const user = useAtomValue(userAtom);

  const { data: balance, refetch: refetchBalance } =
    useUserCreditBalanceQuery();

  const handleAdjustCredits = async () => {
    const amount = Number(state.amountCents);
    if (!Number.isFinite(amount)) {
      dispatch({
        type: "adjust-error",
        error: "Amount must be a valid number",
      });
      return;
    }
    dispatch({ type: "adjust-start" });
    try {
      await topUpUserCredits({
        userId: user?.id!,
        amountCents: amount,
        description: state.description.trim() || undefined,
      });
      // Refresh balance
      await refetchBalance();
      dispatch({
        type: "adjust-success",
        success: `Successfully adjusted credits by ${formatCents(amount)}`,
      });
    } catch (err) {
      dispatch({
        type: "adjust-error",
        error: err instanceof Error ? err.message : "Failed to adjust credits",
      });
    }
  };

  const formatCents = (cents: number) => {
    const dollars = cents / 100;
    const sign = cents >= 0 ? "" : "-";
    const absolute = Math.abs(dollars);
    return `${sign}$${absolute.toFixed(2)}`;
  };

  const handleTriggerAutoReload = async () => {
    dispatch({ type: "auto-reload-start" });
    try {
      await forceCreditAutoReload();
      toast.success("Auto reload triggered successfully");
      await refetchBalance();
      dispatch({ type: "auto-reload-success" });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to trigger auto reload";
      toast.error(errorMessage);
      dispatch({ type: "auto-reload-error", error: errorMessage });
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
            <Loader2 className="size-6 animate-spin" />
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
            value={state.amountCents}
            onChange={(e) =>
              dispatch({
                type: "set-amount-cents",
                amountCents: e.target.value,
              })
            }
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
            placeholder="Reason for adjustment…"
            value={state.description}
            onChange={(e) =>
              dispatch({
                type: "set-description",
                description: e.target.value,
              })
            }
            rows={3}
          />
        </div>

        <Button
          onClick={handleAdjustCredits}
          disabled={state.loading || !state.amountCents}
          className="w-full rounded-full"
        >
          {state.loading ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Processing…
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
          disabled={state.autoReloadLoading}
          className="w-full rounded-full"
          variant="outline"
        >
          {state.autoReloadLoading ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Triggering…
            </>
          ) : (
            "Trigger Auto Reload"
          )}
        </Button>
      </section>

      {state.error && (
        <p
          role="alert"
          className="text-sm text-error rounded-xl border border-error/30 bg-error/5 px-4 py-3"
        >
          {state.error}
        </p>
      )}

      {state.success && (
        <p
          role="status"
          className="text-sm text-success rounded-xl border border-success/30 bg-success/5 px-4 py-3"
        >
          {state.success}
        </p>
      )}
    </div>
  );
}
