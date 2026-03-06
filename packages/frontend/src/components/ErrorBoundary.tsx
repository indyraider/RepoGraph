import { Component, type ErrorInfo, type ReactNode } from "react";
import { XCircle } from "lucide-react";

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: (error: Error) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      return this.props.fallback?.(this.state.error) ?? (
        <div className="min-h-screen bg-gray-950 text-red-400 flex items-center justify-center p-8">
          <div className="max-w-xl text-center">
            <XCircle className="w-10 h-10 mx-auto mb-4 opacity-60" />
            <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
            <pre className="text-sm whitespace-pre-wrap">{this.state.error.message}</pre>
            <pre className="text-xs text-gray-600 mt-2 whitespace-pre-wrap">{this.state.error.stack}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
