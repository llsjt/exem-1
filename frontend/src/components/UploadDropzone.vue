<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{
  filesSelected: [files: File[]];
}>();

const isDragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function emitFiles(files: FileList | null): void {
  const selectedFiles = files ? Array.from(files) : [];

  if (selectedFiles.length > 0) {
    emit('filesSelected', selectedFiles);
  }

  if (fileInput.value) {
    fileInput.value.value = '';
  }
}

function onDrop(event: DragEvent): void {
  isDragging.value = false;
  emitFiles(event.dataTransfer?.files ?? null);
}
</script>

<template>
  <section
    class="upload-dropzone"
    :class="{ 'upload-dropzone--active': isDragging }"
    @dragenter.prevent="isDragging = true"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="onDrop"
  >
    <input
      ref="fileInput"
      class="upload-dropzone__input"
      id="upload-file-input"
      type="file"
      multiple
      @change="emitFiles(($event.target as HTMLInputElement).files)"
    />
    <div class="upload-dropzone__content">
      <p class="upload-dropzone__eyebrow">文件入口</p>
      <h1>大文件分片上传</h1>
      <p class="upload-dropzone__copy">拖拽文件到这里，或从本地选择文件。</p>
      <button class="upload-dropzone__button" type="button" @click="fileInput?.click()">选择文件</button>
    </div>
  </section>
</template>
