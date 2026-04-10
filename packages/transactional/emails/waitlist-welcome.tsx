import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

export const WaitlistWelcomeEmail = ({
  accessLink,
}: {
  accessLink: string;
}) => {
  return (
    <Html>
      <Head />
      <Preview>Welcome to the Leo Alpha!</Preview>
      <Tailwind>
        <Body className="bg-white font-sans">
          <Container className="mx-auto p-5 max-w-[600px]">
            <Section className="mt-6">
              <Heading className="text-2xl font-bold text-gray-900 mb-1">
                Welcome to Leo Alpha! 🎉
              </Heading>

              <Text className="text-base text-gray-700 mb-3">👋 Hi there,</Text>

              <Text className="text-base text-gray-700 mb-3">
                Thanks for signing up for the terragonlabs.com alpha program!
              </Text>

              <Text className="text-base text-gray-700 mb-4">
                <strong>Use the button below to access Leo.</strong>
              </Text>

              <Section className="text-center mb-6">
                <Button
                  href={accessLink}
                  className="bg-green-600 text-white px-8 py-3 rounded-md font-semibold inline-block"
                >
                  Redeem Access Code
                </Button>
              </Section>

              <Heading className="text-xl font-bold text-gray-900 mb-3">
                Getting Started
              </Heading>

              <Section className="mb-0">
                <Heading className="text-lg font-semibold text-gray-900 mb-2">
                  1. Connecting GitHub & Claude Code
                </Heading>

                <Text className="text-base text-gray-700 mb-3">
                  You'll be guided to connect both your GitHub account and
                  Claude Code subscriptions:
                </Text>

                <Link
                  href="https://cdn.terragonlabs.com/censoredlogin.webm"
                  className="text-base text-green-600 underline mb-3 block"
                >
                  View setup video
                </Link>
              </Section>

              <Section className="mb-0">
                <Heading className="text-lg font-semibold text-gray-900 mb-2">
                  2. Resources & Documentation
                </Heading>

                <ul className="list-disc pl-6 mb-4">
                  <li className="text-base text-gray-700 mb-1">
                    <Link
                      href="https://docs.terragonlabs.com/docs/"
                      className="text-green-600 underline"
                    >
                      Documentation & release notes
                    </Link>
                    : we'll continue to keep this updated as the product
                    evolves!
                  </li>
                  <li className="text-base text-gray-700 mb-1">
                    <Link
                      href="https://discord.gg/akupbpGJQF"
                      className="text-green-600 underline"
                    >
                      Discord community
                    </Link>
                    : Join the conversation in Discord to connect with other
                    testers and our development team. We'll be sharing regular
                    product updates in #announcements
                  </li>
                </ul>
              </Section>

              <Section className="mb-0">
                <Heading className="text-lg font-semibold text-gray-900 mb-2">
                  3. Sending feedback
                </Heading>

                <ul className="list-disc pl-6 mb-3">
                  <li className="text-base text-gray-700 mb-1">
                    <strong>In-product feedback:</strong> click the "Send
                    Feedback" button in the Leo sidebar to share in-product
                    feedback via a quick modal
                  </li>
                  <li className="text-base text-gray-700 mb-1">
                    <strong>Discord:</strong> Post bugs in #bugs, feature
                    requests in #feature-requests, and general discussion or
                    questions in #general
                  </li>
                  <li className="text-base text-gray-700 mb-1">
                    <strong>Direct support email:</strong> email{" "}
                    <Link
                      href="mailto:support@terragonlabs.com"
                      className="text-green-600 underline"
                    >
                      support@terragonlabs.com
                    </Link>
                  </li>
                </ul>
              </Section>

              <Hr className="border-gray-300 my-6" />

              <Text className="text-base text-gray-700 mb-3">
                Thanks so much for being part of the early Leo journey! Excited
                to grow this product with you.
              </Text>

              <Text className="text-base text-gray-700 mb-0">
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

export default WaitlistWelcomeEmail;
