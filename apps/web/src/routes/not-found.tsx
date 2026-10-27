import { Link } from "react-router";
import { ScaffoldPage } from "../components/scaffold-page";

export function NotFoundPage() {
  return (
    <ScaffoldPage
      eyebrow="404"
      title="Nothing on this route"
      description="The page does not exist, or it is not part of the current scaffold."
    >
      <Link
        to="/"
        className="inline-flex rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
      >
        Back to projects
      </Link>
    </ScaffoldPage>
  );
}
