import { User } from "@terragon/shared";
import { adminOnly } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";

const INTERNAL_TENANT_MESSAGE =
  "Onboarding and re-engagement campaigns are disabled in internal mode.";

function throwInternalTenantError() {
  throw new UserFacingError(INTERNAL_TENANT_MESSAGE);
}

export const sendOnboardingEmail = adminOnly(async function sendOnboardingEmail(
  adminUser: User,
  email: string,
) {
  void adminUser;
  void email;
  throwInternalTenantError();
});

export const getReengagementPreview = adminOnly(async () => {
  throwInternalTenantError();
});

export const sendReengagementEmails = adminOnly(async (adminUser: User) => {
  void adminUser;
  throwInternalTenantError();
});

export const getOnboardingCompletionPreview = adminOnly(async () => {
  throwInternalTenantError();
});

export const sendOnboardingCompletionEmails = adminOnly(
  async (adminUser: User) => {
    void adminUser;
    throwInternalTenantError();
  },
);
