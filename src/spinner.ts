import chalk from "chalk";
import logSymbols from "log-symbols";
import ora, { type Ora } from "ora";

export type AppSpinner = {
  start: (text?: string) => AppSpinner;
  stop: () => AppSpinner;
  get text(): string;
  set text(value: string);
  get isSpinning(): boolean;
  succeedInfo: (text?: string) => AppSpinner;
  succeedSuccess: (text?: string) => AppSpinner;
  warn: (text?: string) => AppSpinner;
  fail: (text?: string) => AppSpinner;
};

function persist(
  spinner: Ora,
  symbol: string,
  text: string | undefined,
  colorize: (s: string) => string,
): Ora {
  const message = text ?? spinner.text;
  return spinner.stopAndPersist({
    // Space in the symbol so Windows wide ✔ does not eat the gap
    symbol: `${symbol} `,
    text: colorize(message),
  });
}

export function createSpinner(text: string): AppSpinner {
  const spinner = ora(text);

  const api: AppSpinner = {
    start(next?: string) {
      spinner.start(next);
      return api;
    },
    stop() {
      spinner.stop();
      return api;
    },
    get text() {
      return spinner.text;
    },
    set text(value: string) {
      spinner.text = value;
    },
    get isSpinning() {
      return spinner.isSpinning;
    },
    succeedInfo(next?: string) {
      persist(spinner, logSymbols.success, next, chalk.cyan);
      return api;
    },
    succeedSuccess(next?: string) {
      persist(spinner, logSymbols.success, next, chalk.green);
      return api;
    },
    warn(next?: string) {
      persist(spinner, logSymbols.warning, next, chalk.yellow);
      return api;
    },
    fail(next?: string) {
      persist(spinner, logSymbols.error, next, chalk.red);
      return api;
    },
  };

  return api;
}
