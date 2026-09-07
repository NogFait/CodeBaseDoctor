import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { I18nProvider } from "./i18n";

function renderApp() {
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("App — i18n language switcher", () => {
  it("renders in Spanish by default when localStorage is empty", () => {
    renderApp();
    expect(screen.getByRole("button", { name: "Analizar repo" })).toBeInTheDocument();
    expect(screen.getByLabelText("URL del repo de GitHub")).toBeInTheDocument();
    // The switcher's own accessible name is localized too.
    expect(screen.getByRole("group", { name: "Idioma" })).toBeInTheDocument();
  });

  it("re-renders in English after clicking EN in the switcher", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "EN" }));

    expect(screen.getByRole("button", { name: "Scan repo" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Analizar repo" })).not.toBeInTheDocument();
  });

  it("persists the chosen locale so a reload (unmount + remount) keeps it", async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp();
    await user.click(screen.getByRole("button", { name: "EN" }));
    expect(localStorage.getItem("cbd.locale")).toBe("en");
    unmount();

    renderApp();
    expect(screen.getByRole("button", { name: "Scan repo" })).toBeInTheDocument();
  });

  it("boots straight into English when localStorage is pre-seeded with 'en'", () => {
    localStorage.setItem("cbd.locale", "en");
    renderApp();
    expect(screen.getByRole("button", { name: "Scan repo" })).toBeInTheDocument();
  });
});
