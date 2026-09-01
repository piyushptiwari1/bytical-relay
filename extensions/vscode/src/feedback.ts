import * as vscode from "vscode";

const FEEDBACK_URL = "https://ws.relay.bytical.ai/a/feedback";

const KINDS: Array<{ label: string; value: string; description: string }> = [
  { label: "$(star) Review", value: "review", description: "Rate Relay 1-5 and say why" },
  {
    label: "$(lightbulb) Feature idea",
    value: "feature",
    description: "Something Relay should do",
  },
  {
    label: "$(sync) Update request",
    value: "update_request",
    description: "Improve something that exists",
  },
  { label: "$(bug) Bug", value: "bug", description: "Something broke" },
];

/** In-editor feedback → same first-party inbox as the site and the app. */
export async function sendFeedback(extensionVersion: string): Promise<void> {
  const picked = await vscode.window.showQuickPick(KINDS, {
    placeHolder: "What kind of feedback?",
  });
  if (!picked) return;

  let rating: number | undefined;
  if (picked.value === "review") {
    const stars = await vscode.window.showQuickPick(
      [5, 4, 3, 2, 1].map((n) => ({ label: "★".repeat(n) + "☆".repeat(5 - n), n })),
      { placeHolder: "Your rating" },
    );
    if (!stars) return;
    rating = stars.n;
  }

  const message = await vscode.window.showInputBox({
    prompt:
      picked.value === "bug"
        ? "What broke? What did you expect?"
        : "Tell us — goes straight to the maintainers",
    ignoreFocusOut: true,
  });
  if (!message?.trim()) return;

  const contact = await vscode.window.showInputBox({
    prompt: "Email or GitHub handle (optional — only if you want a reply)",
    ignoreFocusOut: true,
  });

  try {
    const response = await fetch(FEEDBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: picked.value,
        rating,
        message: message.trim(),
        contact: contact?.trim() || undefined,
        surface: "vscode",
        version: extensionVersion,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    void vscode.window.showInformationMessage("Thank you — feedback sent to the Relay team.");
  } catch (cause) {
    void vscode.window.showErrorMessage(
      `Could not send feedback (${cause instanceof Error ? cause.message : String(cause)}). GitHub issues work too: https://github.com/piyushptiwari1/bytical-relay/issues`,
    );
  }
}
