import type { Story, StoryDefault } from "@ladle/react";
import { GitDiffPart } from "../git-diff-part";
import type { UIGitDiffPart } from "@leo/shared/db/ui-messages";

// Sample git diff data

const largeDiff: UIGitDiffPart = {
  type: "git-diff",
  diff: `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index 7d4f8a9..2e3b5c1 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,10 +1,12 @@
 import React from 'react';
+import { cn } from '@/lib/utils';
 
 interface ButtonProps {
   children: React.ReactNode;
   onClick?: () => void;
+  className?: string;
 }
 
-export function Button({ children, onClick }: ButtonProps) {
-  return <button onClick={onClick}>{children}</button>;
+export function Button({ children, onClick, className }: ButtonProps) {
+  return <button onClick={onClick} className={cn('px-4 py-2 rounded', className)}>{children}</button>;
 }
diff --git a/src/hooks/useAuth.ts b/src/hooks/useAuth.ts
index 3f5e2a1..8b9c4d7 100644
--- a/src/hooks/useAuth.ts
+++ b/src/hooks/useAuth.ts
@@ -1,5 +1,6 @@
 import { useState, useEffect } from 'react';
 import { auth } from '@/lib/auth';
+import { User } from '@/types/user';
 
 export function useAuth() {
-  const [user, setUser] = useState(null);
+  const [user, setUser] = useState<User | null>(null);
   const [loading, setLoading] = useState(true);
 
   useEffect(() => {
@@ -10,7 +11,7 @@ export function useAuth() {
       setLoading(false);
     });
 
-    return () => unsubscribe();
+    return unsubscribe;
   }, []);
 
   return { user, loading };
diff --git a/package.json b/package.json
index 1234567..8901234 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "my-app",
-  "version": "1.0.0",
+  "version": "1.1.0",
   "description": "My awesome application",
   "main": "index.js",
   "scripts": {
diff --git a/src/server/api/routers/user.ts b/src/server/api/routers/user.ts
index 1234567..8901234 100644
--- a/src/server/api/routers/user.ts
+++ b/src/server/api/routers/user.ts
@@ -1,50 +1,100 @@
 import * as z from "zod/v4";
 import { createTRPCRouter, publicProcedure, protectedProcedure } from "@/server/api/trpc";
+import { TRPCError } from "@trpc/server";
+import { hash, compare } from "bcryptjs";
+import { generateId } from "@/lib/utils";
 
 export const userRouter = createTRPCRouter({
   getAll: publicProcedure.query(async ({ ctx }) => {
-    return ctx.db.user.findMany();
+    return ctx.db.user.findMany({
+      select: {
+        id: true,
+        name: true,
+        email: true,
+        createdAt: true,
+      },
+    });
   }),
 
   getById: publicProcedure
     .input(z.object({ id: z.string() }))
     .query(async ({ ctx, input }) => {
-      return ctx.db.user.findUnique({
+      const user = await ctx.db.user.findUnique({
         where: { id: input.id },
+        select: {
+          id: true,
+          name: true,
+          email: true,
+          createdAt: true,
+          posts: {
+            select: {
+              id: true,
+              title: true,
+              createdAt: true,
+            },
+          },
+        },
       });
+
+      if (!user) {
+        throw new TRPCError({
+          code: "NOT_FOUND",
+          message: "User not found",
+        });
+      }
+
+      return user;
     }),
 });
diff --git a/src/components/Card.tsx b/src/components/Card.tsx
index 1234567..8901234 100644
--- a/src/components/Card.tsx
+++ b/src/components/Card.tsx
@@ -1,10 +1,15 @@
 import React from 'react';
+import { cn } from '@/lib/utils';
 
 interface CardProps {
   children: React.ReactNode;
+  className?: string;
+  title?: string;
 }
 
-export function Card({ children }: CardProps) {
+export function Card({ children, className, title }: CardProps) {
   return (
-    <div className="card">{children}</div>
+    <div className={cn('card p-4 rounded-lg shadow', className)}>
+      {title && <h3 className="text-lg font-semibold mb-2">{title}</h3>}
+      {children}
+    </div>
   );
 }
diff --git a/src/utils/format.ts b/src/utils/format.ts
index 2345678..9012345 100644
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -1,5 +1,10 @@
 export function formatDate(date: Date): string {
   return date.toLocaleDateString();
 }
 
+export function formatDateTime(date: Date): string {
+  return date.toLocaleString();
+}
+
 export function formatCurrency(amount: number): string {
+  return new Intl.NumberFormat('en-US', {
+    style: 'currency',
+    currency: 'USD',
+  }).format(amount);
 }`,
  timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 minutes ago
};

const manyFilesDiff: UIGitDiffPart = {
  type: "git-diff",
  diff: Array.from(
    { length: 10 },
    (_, i) => `diff --git a/src/file${i + 1}.ts b/src/file${i + 1}.ts
index 1234567..8901234 100644
--- a/src/file${i + 1}.ts
+++ b/src/file${i + 1}.ts
@@ -1,3 +1,5 @@
 export function func${i + 1}() {
-  return ${i + 1};
+  // Updated implementation
+  const result = ${i + 1} * 2;
+  return result;
 }`,
  ).join("\n"),
  timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 minutes ago
};

export const LargeChangeSet: Story = () => {
  return (
    <div className="p-4">
      <GitDiffPart gitDiffPart={largeDiff} />
    </div>
  );
};

export const ManyFiles: Story = () => {
  return (
    <div className="p-4">
      <p className="text-muted-foreground mb-4 text-sm italic">
        More than 5 files - should default to collapsed:
      </p>
      <GitDiffPart gitDiffPart={manyFilesDiff} />
    </div>
  );
};

export const TooLargeDiff: Story = () => {
  return (
    <div className="p-4">
      <GitDiffPart
        gitDiffPart={{
          type: "git-diff",
          diff: "too-large",
          diffStats: { files: 100, additions: 100, deletions: 100 },
          timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30 minutes ago
        }}
      />
    </div>
  );
};

export default {
  title: "Chat/GitDiffPart",
} satisfies StoryDefault;
