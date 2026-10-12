// Media operations (40 §17) on the api host. Needs MediaModule (global).
import { Module } from '@nestjs/common';
import {
  MediaAttachHandler,
  MediaAttachmentUpdateHandler,
  MediaDeleteHandler,
  MediaDetachHandler,
  MediaDownloadUrlHandler,
  MediaGetHandler,
  MediaRedactionDecideHandler,
  MediaUploadCompleteHandler,
  MediaUploadInitHandler,
} from './application/media-ops.js';

@Module({
  providers: [
    MediaUploadInitHandler,
    MediaUploadCompleteHandler,
    MediaGetHandler,
    MediaDownloadUrlHandler,
    MediaAttachHandler,
    MediaAttachmentUpdateHandler,
    MediaDetachHandler,
    MediaDeleteHandler,
    MediaRedactionDecideHandler,
  ],
})
export class MediaApiModule {}
