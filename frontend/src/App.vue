<template>
  <main class="app-shell">
    <UploadDropzone @files-selected="store.addFiles" />
    <UploadTaskList
      :tasks="store.tasks"
      @pause="store.pauseTask"
      @resume="store.resumeTask"
      @cancel="store.cancelTask"
    />
  </main>
</template>

<script setup lang="ts">
import UploadDropzone from './components/UploadDropzone.vue';
import UploadTaskList from './components/UploadTaskList.vue';
import { uploadStore } from './stores/uploadStore';

const store = uploadStore;
</script>
