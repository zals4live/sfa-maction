<script setup lang="ts">
// Digital signature canvas for visit-out (visit completion) — SHARED by SALESMAN & MR.
// Both field roles complete visits, so this component is role-agnostic (no role gating).
// It captures the customer/PIC signature as freehand strokes on an HTML5 <canvas> (pointer
// events with a touch fallback, page-scroll suppressed while drawing), exports the drawing
// to a PNG, then uploads it DIRECTLY to S3 via a pre-signed URL from
// `POST /visits/:id/signature-upload-url` (binary never touches the API server). The
// resulting `s3_key` is emitted as `saved` so the visit-out flow can attach it as
// `signature_s3_key` on `POST /visits/:id/end`. All stroke geometry + the empty-signature
// guard live in the pure `signature-pad.ts` helper so this SFC stays a thin shell. Forced
// light mode (no dark: variants).
import { onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useSignatureCapture } from '~/composables/useSignatureCapture'
import {
  appendPoint,
  beginStroke,
  createEmptySignature,
  isSignatureEmpty,
  toCanvasPoint,
  type SignatureStrokes
} from '~/lib/signature/signature-pad'

interface Props {
  /** Target visit the signature is captured for (drives the pre-signed URL endpoint). */
  visitId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** Emitted after the signature PNG is uploaded, carrying the stored S3 key. */
  (e: 'saved', s3Key: string): void
}>()

const toast = useToast()
const { encode, upload, isUploading, reset: resetCapture } = useSignatureCapture()

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')

/** Whether anything has been drawn yet — gates the save button. */
const hasSignature = ref<boolean>(false)
const saving = ref<boolean>(false)

let strokes: SignatureStrokes = createEmptySignature()
let drawing = false
let activePointerId: number | null = null

/** Pen appearance for the stroke context (design tokens are Tailwind-side, canvas is raw). */
const STROKE_COLOR = '#1C4173'
const STROKE_WIDTH = 2.5

/** Resolve the 2D drawing context, configured for smooth ink strokes. */
function getContext(): CanvasRenderingContext2D | null {
  const context = canvasRef.value?.getContext('2d') ?? null
  if (!context) return null
  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.lineWidth = STROKE_WIDTH
  context.strokeStyle = STROKE_COLOR
  return context
}

/** Map a pointer/touch event to canvas pixel space via the pure helper. */
function pointFromEvent(clientX: number, clientY: number) {
  const canvas = canvasRef.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  return toCanvasPoint(clientX, clientY, rect, canvas.width, canvas.height)
}

/** Draw the segment from the previous point of the active stroke to the new point. */
function drawSegment(context: CanvasRenderingContext2D, strokeIndex: number): void {
  const stroke = strokes[strokeIndex]
  if (!stroke || stroke.length === 0) return
  const to = stroke[stroke.length - 1]!
  const from = stroke.length >= 2 ? stroke[stroke.length - 2]! : to
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
}

function onPointerDown(event: PointerEvent): void {
  const point = pointFromEvent(event.clientX, event.clientY)
  const context = getContext()
  if (!point || !context) return
  drawing = true
  activePointerId = event.pointerId
  canvasRef.value?.setPointerCapture?.(event.pointerId)
  strokes = beginStroke(strokes, point)
  // Render the initial dot so a tap produces a visible mark.
  drawSegment(context, strokes.length - 1)
  hasSignature.value = !isSignatureEmpty(strokes)
}

function onPointerMove(event: PointerEvent): void {
  if (!drawing || event.pointerId !== activePointerId) return
  // Suppress page scroll / gesture while drawing.
  event.preventDefault()
  const point = pointFromEvent(event.clientX, event.clientY)
  const context = getContext()
  if (!point || !context) return
  strokes = appendPoint(strokes, point)
  drawSegment(context, strokes.length - 1)
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return
  drawing = false
  activePointerId = null
  canvasRef.value?.releasePointerCapture?.(event.pointerId)
}

/** Clear the canvas pixels and reset the stroke model + any encoded blob. */
function clear(): void {
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  if (canvas && context) {
    context.clearRect(0, 0, canvas.width, canvas.height)
  }
  strokes = createEmptySignature()
  hasSignature.value = false
  resetCapture()
}

/** Encode the current drawing to PNG, upload it to S3, and emit the resulting key. */
async function save(): Promise<void> {
  const canvas = canvasRef.value
  if (!canvas || isSignatureEmpty(strokes)) {
    toast.add({
      title: 'Tanda tangan kosong',
      description: 'Mohon bubuhkan tanda tangan terlebih dahulu.',
      color: 'warning',
      icon: 'i-lucide-pen-line'
    })
    return
  }
  saving.value = true
  try {
    const encoded = await encode(canvas)
    if (!encoded) throw new Error('encode_failed')
    const s3Key = await upload(props.visitId)
    emit('saved', s3Key)
    toast.add({
      title: 'Tanda tangan tersimpan',
      description: 'Tanda tangan berhasil diunggah.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch {
    toast.add({
      title: 'Gagal menyimpan tanda tangan',
      description: 'Terjadi kesalahan. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    saving.value = false
  }
}

// Ensure any lingering pointer capture is released if the component unmounts mid-stroke.
onBeforeUnmount(() => {
  if (activePointerId !== null) {
    canvasRef.value?.releasePointerCapture?.(activePointerId)
  }
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-lg border border-default bg-default p-2">
      <canvas
        ref="canvas"
        width="600"
        height="240"
        class="w-full touch-none rounded-md bg-elevated"
        aria-label="Kanvas tanda tangan"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerUp"
      />
    </div>

    <div class="flex items-center gap-3">
      <UButton
        variant="outline"
        color="neutral"
        size="lg"
        icon="i-lucide-eraser"
        :disabled="saving || isUploading"
        @click="clear"
      >
        Hapus
      </UButton>
      <UButton
        block
        size="lg"
        icon="i-lucide-save"
        :loading="saving || isUploading"
        :disabled="!hasSignature || saving || isUploading"
        @click="save"
      >
        Simpan Tanda Tangan
      </UButton>
    </div>
  </div>
</template>
