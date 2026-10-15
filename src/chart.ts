import { escapeAttribute, escapeText } from './layout.ts';

/**
 * The traffic chart, drawn in HTML.
 *
 * A bar chart of fourteen integers does not need a drawing library, and it
 * particularly does not need one that scales its own text: an SVG with a fixed
 * viewBox shrinks its labels as the viewport narrows until they are unreadable,
 * and the alternative — recomputing pixel geometry in JavaScript on resize — is
 * a charting library with a worse API. Flex columns with percentage heights
 * scale to any width, and the labels stay the size the browser decided they
 * should be.
 *
 * There is no JavaScript here at all, which is deliberate: this is the page a
 * stranger lands on, and it should render with the same fidelity for a reader
 * with scripting off, a reader on a text browser, and the archive crawler that
 * will one day be the only thing still reading it.
 */

/** One day of traffic. `date` is a UTC calendar date, `YYYY-MM-DD`. */
export interface DayBar {
  date: string;
  calls: number;
  answered: number;
}

export interface ChartOptions {
  /** The chart's own heading, e.g. "Calls per day". */
  title: string;
  /** A short caption beside the title: the window, and the timezone. */
  note: string;
  /** Shown instead of a plot when there has been no traffic at all. */
  emptyNote: string;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function summary(days: readonly DayBar[]): string {
  const calls = days.reduce((total, day) => total + day.calls, 0);
  const answered = days.reduce((total, day) => total + day.answered, 0);
  const from = days[0]?.date ?? '';
  const to = days[days.length - 1]?.date ?? '';
  return `${calls} call${calls === 1 ? '' : 's'} and ${answered} answer${answered === 1 ? '' : 's'} from ${from} to ${to}`;
}

export function chart(days: readonly DayBar[], options: ChartOptions): string {
  const calls = days.reduce((total, day) => total + day.calls, 0);
  const empty = calls === 0;
  // The scale never divides by zero: with no traffic every bar is zero height
  // and the divisor is irrelevant, which is cheaper than a special case.
  const max = Math.max(1, ...days.map((day) => day.calls));

  const columns = days
    .map((day) => {
      const waiting = Math.max(0, day.calls - day.answered);
      const label = `${day.date} · ${day.calls} call${day.calls === 1 ? '' : 's'} · ${day.answered} answered`;
      const segments = [
        `<span class="seg-waiting" style="height:${round((waiting / max) * 100)}%"></span>`,
        `<span class="seg-answered" style="height:${round((day.answered / max) * 100)}%"></span>`,
      ].join('');
      return `<div class="col" title="${escapeAttribute(label)}">${segments}</div>`;
    })
    .join('');

  const ticks = days
    .map((day) => `<span>${escapeText(day.date.slice(8))}</span>`)
    .join('');

  const numbers = days
    .map((day) => `<li>${escapeText(day.date)} — ${day.calls} / ${day.answered}</li>`)
    .join('');

  const from = days[0]?.date ?? '';
  const to = days[days.length - 1]?.date ?? '';

  return `<figure class="figure${empty ? ' is-empty' : ''}">
  <div class="fig-head">
    <span class="fig-title">${escapeText(options.title)}</span>
    <span class="fig-note">${escapeText(options.note)}</span>
  </div>
  <div class="bars" role="img" aria-label="${escapeAttribute(summary(days))}">${columns}</div>
  <div class="ticks" aria-hidden="true">${ticks}</div>
  ${empty ? `<p class="chart-note">${escapeText(options.emptyNote)}</p>` : ''}
  <details class="fig-data">
    <summary>the numbers</summary>
    <p class="fig-data-note">Calls / answered, ${escapeText(from)} to ${escapeText(to)}, UTC. Answered is counted on the
    day it was answered, which is why a call made just before midnight can appear in one day's calls and the next
    day's answers.</p>
    <ul>${numbers}</ul>
  </details>
</figure>`;
}
