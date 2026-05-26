<script setup lang="ts">
import { computed } from 'vue';
import type { UploadTask } from '../stores/uploadStore';

const props = defineProps<{
  task: UploadTask;
}>();

const emit = defineEmits<{
  pause: [taskId: string];
  resume: [taskId: string];
  cancel: [taskId: string];
}>();

const statusLabels: Record<UploadTask['status'], string> = {
  hashing: '计算指纹',
  uploading: '上传中',
  paused: '已暂停',
  failed: '失败',
  merging: '合并中',
  success: '完成',
  canceled: '已取消'
};

const canPause = computed(() => ['hashing', 'uploading'].includes(props.task.status));
const canResume = computed(() => ['paused', 'failed'].includes(props.task.status));
const canCancel = computed(() => !['success', 'canceled'].includes(props.task.status));

const fileSize = computed(() => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = props.task.fileSize;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
});

const progressText = computed(() => `${props.task.progress}%`);
</script>

<template>
  <article class="upload-task">
    <div class="upload-task__main">
      <div class="upload-task__title-row">
        <h3>{{ task.fileName }}</h3>
        <span class="upload-task__status" :data-status="task.status">{{ statusLabels[task.status] }}</span>
      </div>
      <div class="upload-task__meta">
        <span>{{ fileSize }}</span>
        <span>{{ task.message }}</span>
      </div>
      <div
        class="upload-task__progress"
        role="progressbar"
        :aria-valuenow="task.progress"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span :style="{ width: progressText }"></span>
      </div>
    </div>

    <div class="upload-task__actions" aria-label="任务操作">
      <button v-if="canPause" type="button" @click="emit('pause', task.id)">暂停</button>
      <button v-if="canResume" type="button" @click="emit('resume', task.id)">继续</button>
      <button v-if="canCancel" class="button-secondary" type="button" @click="emit('cancel', task.id)">取消</button>
    </div>
  </article>
</template>
