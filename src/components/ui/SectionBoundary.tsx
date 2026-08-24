"use client";

import { Component, type ReactNode } from "react";
import { ErrorState } from "./primitives";

/**
 * Keeps one failing section from taking the whole page with it.
 *
 * The dashboard reads a dozen different parts of the database. Without this, a
 * single timed-out aggregate replaces every panel with one error screen, and the
 * approvals waiting in the next card are lost with it. Each band is wrapped, so a
 * failure costs its own section and nothing else.
 */
export class SectionBoundary extends Component<
  { children: ReactNode; label?: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Section failed to render", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="card">
          <ErrorState
            title={this.props.label ? `${this.props.label} could not be loaded` : "This section could not be loaded"}
            description="The rest of the page is unaffected. Reload to try this section again."
          />
        </div>
      );
    }
    return this.props.children;
  }
}
