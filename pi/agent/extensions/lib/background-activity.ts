export const BACKGROUND_ACTIVITY_STARTED = "pi:background-activity-started"
export const BACKGROUND_ACTIVITY_FINISHED = "pi:background-activity-finished"

export type BackgroundActivity = {
  id: string
  source: string
  label: string
}
