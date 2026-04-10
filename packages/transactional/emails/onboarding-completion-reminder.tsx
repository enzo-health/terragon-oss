import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

interface OnboardingCompletionReminderEmailProps {
  dashboardLink: string;
}

export const OnboardingCompletionReminderEmail = ({
  dashboardLink,
}: OnboardingCompletionReminderEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Forget something?</Preview>
      <Tailwind>
        <Body className="bg-white font-sans">
          <Container className="mx-auto p-5 max-w-[600px]">
            <Section className="mt-2">
              <Heading className="text-2xl font-bold text-gray-900 mb-1">
                Forget something?
              </Heading>

              <Text className="text-base text-gray-700 mb-3">👋 Hi there,</Text>

              <Text className="text-base text-gray-700 mb-3">
                You've connected GitHub and Claude Code, but haven't created a
                task, so you aren't seeing Leo shine!
              </Text>

              <Text className="text-base text-gray-700 mb-4">
                Try one of these suggested tasks:
              </Text>

              <ul className="list-disc pl-6 mb-4">
                <li className="text-base text-gray-700 mb-1">
                  <strong>Update Claude.md</strong>
                </li>
                <li className="text-base text-gray-700 mb-1">
                  <strong>Improve test coverage</strong>
                </li>
                <li className="text-base text-gray-700 mb-1">
                  <strong>Find potential bugs and TODOS</strong>
                </li>
              </ul>

              <Section className="text-center mb-6">
                <Button
                  href={dashboardLink}
                  className="bg-green-600 text-white px-8 py-3 rounded-md font-semibold inline-block"
                >
                  Create Your First Task
                </Button>
              </Section>

              <Section className="bg-green-50 p-4 rounded-md mb-3">
                <Text className="text-base text-gray-700 mb-0">
                  <strong>💡 Tip:</strong> You can @ mention files, paste URLs,
                  upload images, or use voice input to describe your task.
                </Text>
              </Section>

              <Text className="text-base text-gray-700 mb-0">
                Need additional help? Email{" "}
                <Link
                  href="mailto:support@terragonlabs.com"
                  className="text-green-600 underline"
                >
                  support@terragonlabs.com
                </Link>{" "}
                or join our{" "}
                <Link
                  href="https://discord.com/invite/akupbpGJQF"
                  className="text-green-600 underline"
                >
                  Discord community
                </Link>
                .
              </Text>

              <Text className="text-base text-gray-700 mt-6 mb-0">
                Best,
                <br />
                Leo team
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

export default OnboardingCompletionReminderEmail;
