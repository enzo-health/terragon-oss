"use server";

import { r2Cdn } from "@/lib/r2-cdn";
import { adminOnly } from "@/lib/auth-server";
import { User } from "@leo/shared";

export const listR2Objects = adminOnly(async function listR2Objects(
  adminUser: User,
  prefix?: string,
) {
  try {
    const result = await r2Cdn.listObjects(prefix, 1000);

    // Convert to a tree structure
    const tree = buildTreeFromKeys(
      result.objects.map((obj) => ({
        ...obj,
        url: r2Cdn.getPublicR2Url(obj.key),
      })),
    );

    return {
      tree,
      isTruncated: result.isTruncated,
      nextContinuationToken: result.nextContinuationToken,
    };
  } catch (error) {
    console.error("Error listing R2 objects:", error);
    throw new Error("Failed to list R2 objects");
  }
});

export const deleteR2Object = adminOnly(async function deleteR2Object(
  adminUser: User,
  key: string,
) {
  try {
    await r2Cdn.deleteObject(key);
    return { success: true };
  } catch (error) {
    console.error("Error deleting R2 object:", error);
    throw new Error("Failed to delete R2 object");
  }
});

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  size?: number;
  lastModified?: Date;
  url?: string | null;
}

function buildTreeFromKeys(
  objects: Array<{
    key: string;
    size: number;
    lastModified: Date;
    url: string | null;
  }>,
): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  // Sort objects by key to ensure folders are created before files
  objects.sort((a, b) => a.key.localeCompare(b.key));

  for (const obj of objects) {
    const parts = obj.key.split("/");
    let currentPath = "";
    let parentArray = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue; // Skip empty parts from double slashes

      currentPath = currentPath ? `${currentPath}/${part}` : part;

      const isFile = i === parts.length - 1;
      const nodeKey = currentPath;

      if (!nodeMap.has(nodeKey)) {
        const node: TreeNode = {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
        };

        if (isFile) {
          node.size = obj.size;
          node.lastModified = obj.lastModified;
          node.url = obj.url;
        } else {
          node.children = [];
        }

        nodeMap.set(nodeKey, node);
        parentArray.push(node);
      }

      if (!isFile) {
        const node = nodeMap.get(nodeKey)!;
        parentArray = node.children!;
      }
    }
  }

  return root;
}
