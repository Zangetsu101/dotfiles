export function backgroundAttachCommand(task: { id: string; target: string }): string {
  return process.env.TMUX ? `/task attach ${task.id}` : `tmux attach -t ${task.target}`
}
