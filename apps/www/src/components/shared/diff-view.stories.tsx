import type { Story, StoryDefault } from "@ladle/react";
import { HighlightedDiffView } from "./diff-view";

// Sample git diff data
const singleFileDiff = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
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
 }`;

const multipleFilesDiff = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
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
   "scripts": {`;

const largeFileDiff = `diff --git a/src/server/api/routers/user.ts b/src/server/api/routers/user.ts
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

   create: publicProcedure
     .input(
       z.object({
-        name: z.string(),
-        email: z.string().email(),
+        name: z.string().min(1).max(100),
+        email: z.string().email().toLowerCase(),
+        password: z.string().min(8),
       })
     )
     .mutation(async ({ ctx, input }) => {
+      const existingUser = await ctx.db.user.findUnique({
+        where: { email: input.email },
+      });
+
+      if (existingUser) {
+        throw new TRPCError({
+          code: "CONFLICT",
+          message: "User with this email already exists",
+        });
+      }
+
+      const hashedPassword = await hash(input.password, 10);
+
       return ctx.db.user.create({
         data: {
+          id: generateId(),
           name: input.name,
           email: input.email,
+          password: hashedPassword,
         },
       });
     }),

   update: protectedProcedure
     .input(
       z.object({
-        id: z.string(),
-        name: z.string().optional(),
-        email: z.string().email().optional(),
+        name: z.string().min(1).max(100).optional(),
+        bio: z.string().max(500).optional(),
       })
     )
     .mutation(async ({ ctx, input }) => {
       return ctx.db.user.update({
-        where: { id: input.id },
-        data: {
-          name: input.name,
-          email: input.email,
-        },
+        where: { id: ctx.session.user.id },
+        data: input,
       });
     }),
+
+  delete: protectedProcedure.mutation(async ({ ctx }) => {
+    await ctx.db.user.delete({
+      where: { id: ctx.session.user.id },
+    });
+    return { success: true };
+  }),
 });`;

const fileRenameDiff = `diff --git a/src/OldComponent.tsx b/src/NewComponent.tsx
similarity index 85%
rename from src/OldComponent.tsx
rename to src/NewComponent.tsx
index 1234567..8901234 100644
--- a/src/OldComponent.tsx
+++ b/src/NewComponent.tsx
@@ -1,8 +1,8 @@
 import React from 'react';

-export function OldComponent() {
+export function NewComponent() {
   return (
-    <div className="old-component">
+    <div className="new-component">
       <h1>Hello World</h1>
     </div>
   );`;

const longFilePathDiff = `diff --git a/src/components/very/long/nested/directory/structure/that/causes/overflow/on/mobile/devices/ComponentWithVeryLongNameThatExceedsNormalBounds.tsx b/src/components/very/long/nested/directory/structure/that/causes/overflow/on/mobile/devices/ComponentWithVeryLongNameThatExceedsNormalBounds.tsx
index 1234567..8901234 100644
--- a/src/components/very/long/nested/directory/structure/that/causes/overflow/on/mobile/devices/ComponentWithVeryLongNameThatExceedsNormalBounds.tsx
+++ b/src/components/very/long/nested/directory/structure/that/causes/overflow/on/mobile/devices/ComponentWithVeryLongNameThatExceedsNormalBounds.tsx
@@ -1,5 +1,6 @@
 import React from 'react';
+import { cn } from '@/lib/utils';

 export function ComponentWithVeryLongName() {
-  return <div>Hello</div>;
+  return <div className={cn('p-4')}>Hello World</div>;
 }
diff --git a/packages/shared/src/database/migrations/2024_01_15_000000_create_users_table_with_additional_fields_for_authentication.sql b/packages/shared/src/database/migrations/2024_01_15_000000_create_users_table_with_additional_fields_for_authentication.sql
index 2345678..9012345 100644
--- a/packages/shared/src/database/migrations/2024_01_15_000000_create_users_table_with_additional_fields_for_authentication.sql
+++ b/packages/shared/src/database/migrations/2024_01_15_000000_create_users_table_with_additional_fields_for_authentication.sql
@@ -3,6 +3,7 @@ CREATE TABLE users (
   name VARCHAR(255) NOT NULL,
   email VARCHAR(255) UNIQUE NOT NULL,
   password VARCHAR(255) NOT NULL,
+  email_verified BOOLEAN DEFAULT FALSE,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
 );`;

export const SingleFile: Story = () => {
  return (
    <div className="p-4">
      <HighlightedDiffView patch={singleFileDiff} />
    </div>
  );
};

export const MultipleFiles: Story = () => {
  return (
    <div className="p-4">
      <HighlightedDiffView patch={multipleFilesDiff} />
    </div>
  );
};

export const LargeFile: Story = () => {
  return (
    <div className="p-4">
      <HighlightedDiffView patch={largeFileDiff} />
    </div>
  );
};

export const FileRename: Story = () => {
  return (
    <div className="p-4">
      <HighlightedDiffView patch={fileRenameDiff} />
    </div>
  );
};

export const LongFilePaths: Story = () => {
  return (
    <div className="p-4">
      <HighlightedDiffView patch={longFilePathDiff} />
    </div>
  );
};

export default {
  title: "DiffView",
} satisfies StoryDefault;
