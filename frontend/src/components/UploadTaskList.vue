<script setup lang="ts">
import type { UploadTask } from '../stores/uploadStore';
import UploadTaskItem from './UploadTaskItem.vue';

defineProps<{
  tasks: UploadTask[];
}>();

const emit = defineEmits<{
  pause: [taskId: string];
  resume: [taskId: string];
  cancel: [taskId: string];
}>();
</script>

<template>
  <section class="upload-task-list" aria-label="上传任务列表">
    <div class="upload-task-list__header">
      <h2>上传任务</h2>
      <span>{{ tasks.length }} 个任务</span>
    </div>

    <div v-if="tasks.length === 0" class="upload-task-list__empty">等待文件加入队列</div>

    <div v-else class="upload-task-list__items">
      <UploadTaskItem
        v-for="task in tasks"
        :key="task.id"
        :task="task"
        @pause="emit('pause', $event)"
        @resume="emit('resume', $event)"
        @cancel="emit('cancel', $event)"
      />
    </div>
  </section>
</template>
