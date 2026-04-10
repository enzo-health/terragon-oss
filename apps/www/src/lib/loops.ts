import { LoopsClient, TransactionalVariables } from "loops";
import { env } from "@leo/env/apps-www";
import { db } from "./db";
import { user } from "@leo/shared/db/schema";
import { eq } from "drizzle-orm";

/**
 * Send an event to Loops for a user (best-effort)
 * @param userId - The user ID
 * @param eventName - The event name
 * @param eventProperties - Additional event properties
 */
export async function sendLoopsEvent(
  userId: string,
  eventName: string,
  eventProperties?: Record<string, unknown>,
) {
  try {
    // Skip if Loops API key is not configured
    if (!env.LOOPS_API_KEY) {
      return;
    }

    // Fetch user email from database
    const userRecord = await db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: {
        email: true,
      },
    });

    if (!userRecord?.email) {
      return;
    }

    // Initialize Loops client and send event
    const loops = new LoopsClient(env.LOOPS_API_KEY);
    await loops.sendEvent({
      email: userRecord.email,
      eventName,
      eventProperties: {
        userId,
        ...eventProperties,
      },
    });
  } catch (err) {
    // Log error but don't throw - this is a best-effort operation
    console.warn(`Loops sendEvent failed for event ${eventName}:`, err);
  }
}

/**
 * Send a transactional email via Loops (best-effort)
 * @param params - Email parameters
 */
export async function sendLoopsTransactionalEmail(params: {
  email: string;
  transactionalId: string;
  dataVariables?: TransactionalVariables;
  addToAudience?: boolean;
}) {
  try {
    // Skip if Loops API key is not configured
    if (!env.LOOPS_API_KEY) {
      console.log("Loops API key not configured, skipping transactional email");
      return;
    }

    // Initialize Loops client and send transactional email
    const loops = new LoopsClient(env.LOOPS_API_KEY);
    await loops.sendTransactionalEmail({
      email: params.email,
      transactionalId: params.transactionalId,
      dataVariables: params.dataVariables,
      addToAudience: params.addToAudience ?? false,
    });
  } catch (err) {
    // Log error but don't throw - this is a best-effort operation
    console.warn(
      `Loops sendTransactionalEmail failed for template ${params.transactionalId}:`,
      err,
    );
  }
}

/**
 * Update contact properties in Loops (best-effort)
 * @param userId - The user ID
 * @param properties - Contact properties to update
 */
export async function updateLoopsContact(
  userId: string,
  properties: Record<string, unknown>,
) {
  try {
    // Skip if Loops API key is not configured
    if (!env.LOOPS_API_KEY) {
      return;
    }

    // Fetch user email from database
    const userRecord = await db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: {
        email: true,
      },
    });

    if (!userRecord?.email) {
      return;
    }

    // Initialize Loops client and update contact
    const loops = new LoopsClient(env.LOOPS_API_KEY);
    await loops.updateContact({
      email: userRecord.email,
      properties: {
        ...properties,
        userId, // Always include userId
      },
    });
  } catch (err) {
    // Log error but don't throw - this is a best-effort operation
    console.warn("Loops updateContact failed:", err);
  }
}
