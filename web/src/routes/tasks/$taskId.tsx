import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTaskDetail, useEventStore } from "../../store/eventStore.js";

export const Route = createFileRoute("/tasks/$taskId")({
  component: TaskDetail,
});

function TaskDetail() {
  const { taskId } = Route.useParams();
  const taskDetail = useTaskDetail(taskId);

  // Hydrate task detail from REST if not in the event store
  useQuery({
    queryKey: ["task_detail", taskId],
    queryFn: async () => {
      const res = await fetch(`/api/projections/task_detail/${taskId}`);
      if (!res.ok) return null;
      const detail = await res.json();
      useEventStore.setState((s) => ({
        taskDetail: { ...s.taskDetail, [taskId]: detail },
      }));
      return detail;
    },
    enabled: !taskDetail,
    staleTime: Infinity,
  });

  return <Outlet />;
}
