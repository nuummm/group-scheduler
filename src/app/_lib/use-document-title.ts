import { useEffect } from "react";
import { appConfig } from "./app-config";

/** タブの題名。index.html の題名を、開いている画面に合わせて差し替える。 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    const { appName } = appConfig();
    document.title = title ? `${title} | ${appName}` : appName;
  }, [title]);
}
