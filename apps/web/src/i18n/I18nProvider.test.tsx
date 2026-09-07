import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "./I18nProvider";
import { useLocale, useT } from "./useT";

function Probe() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <div>
      <p data-testid="msg">{t("urlEntry.submit")}</p>
      <p data-testid="loc">{locale}</p>
      <button type="button" onClick={() => setLocale("en")}>
        to-en
      </button>
    </div>
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
  vi.restoreAllMocks();
});

describe("I18nProvider", () => {
  it("defaults to Spanish when localStorage is empty", () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("loc")).toHaveTextContent("es");
    expect(screen.getByTestId("msg")).toHaveTextContent("Analizar repo");
  });

  it("reads a pre-seeded localStorage['cbd.locale']", () => {
    localStorage.setItem("cbd.locale", "en");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("loc")).toHaveTextContent("en");
    expect(screen.getByTestId("msg")).toHaveTextContent("Scan repo");
  });

  it("ignores an invalid stored value and falls back to 'es'", () => {
    localStorage.setItem("cbd.locale", "fr");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("loc")).toHaveTextContent("es");
  });

  it("setLocale re-renders with the new locale and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "to-en" }));
    expect(screen.getByTestId("msg")).toHaveTextContent("Scan repo");
    expect(localStorage.getItem("cbd.locale")).toBe("en");
  });

  it("does not crash when localStorage throws on read (falls back to 'es')", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage disabled");
    });
    expect(() =>
      render(
        <I18nProvider>
          <Probe />
        </I18nProvider>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId("loc")).toHaveTextContent("es");
  });

  it("does not crash when localStorage throws on write", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("localStorage disabled");
    });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "to-en" }));
    expect(screen.getByTestId("msg")).toHaveTextContent("Scan repo");
  });

  it("forces a locale via initialLocale regardless of stored value", () => {
    localStorage.setItem("cbd.locale", "en");
    render(
      <I18nProvider initialLocale="es">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("loc")).toHaveTextContent("es");
  });

  it("useT throws when used outside an I18nProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useT();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/I18nProvider/);
  });
});
