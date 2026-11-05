import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FactoryPage } from "../components/factories/FactoryPage";
import { validateWorkItemSearch } from "../components/factories/workItems.logic";

function FactoryRouteView() {
  const { environmentId, factoryId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <FactoryPage
      key={`${environmentId}\n${factoryId}`}
      environmentId={EnvironmentId.make(environmentId)}
      factoryId={factoryId}
      workItemSearch={search}
      onWorkItemSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}

export const Route = createFileRoute("/_chat/factories/$environmentId/$factoryId")({
  validateSearch: validateWorkItemSearch,
  component: FactoryRouteView,
});
