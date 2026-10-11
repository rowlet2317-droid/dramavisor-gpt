import { requirePageUser } from "../../../lib/auth/page-session";

import { NewPlayForm } from "./new-play-form";

export default async function NewPlayPage() {
  await requirePageUser();
  return <NewPlayForm />;
}
