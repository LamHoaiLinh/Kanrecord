# Kanrecode

**Kanrecode** là ứng dụng quay màn hình chạy trực tiếp trong trình duyệt, tối ưu cho video hướng dẫn desktop và thao tác nhanh. Giao diện dùng tone xanh lá pastel, không cần tài khoản và bản ghi được xử lý cục bộ trên máy.

## Điểm chính của bản Kanrecode

- Chọn một hoặc nhiều nguồn: tab, cửa sổ hoặc toàn màn hình.
- Kéo, phóng to/thu nhỏ, xoay, đổi độ mờ và layer của từng nguồn trên canvas.
- Quay không cần microphone hoặc chọn microphone khi cần.
- Trộn microphone với audio của tab/màn hình nếu trình duyệt cung cấp audio track.
- 25 / 30 / 60 FPS và bitrate 4 / 8 / 12 / 20 Mbps.
- MP4 khi trình duyệt hỗ trợ; tự fallback sang WebM khi cần.
- Pause / Resume trong lúc ghi.
- Camera talking-head, xóa nền bằng MediaPipe, filter và điều chỉnh vị trí.
- Bút chú thích trực tiếp khi ghi.
- Teleprompter và xuất thêm TXT / SRT / VTT khi sử dụng lời thoại.
- Nền màu, nền ảnh và logo tùy chọn.
- Tooltip, hover highlight và quy trình 3 bước để giảm thao tác.

## Chạy nhanh trên Windows

1. Tải hoặc clone repo.
2. Nhấp đúp `START_KANRECODE.bat`.
3. Trình duyệt mở `http://127.0.0.1:8765`.

Yêu cầu: máy có Python hoặc Python Launcher (`py`). Nếu đã có một web server riêng, chỉ cần phục vụ thư mục này qua `localhost` hoặc HTTPS.

> Không mở trực tiếp `index.html` bằng `file://`, vì API quay màn hình của trình duyệt yêu cầu secure context; `localhost` được trình duyệt chấp nhận.

## Gợi ý thiết lập

- Video hướng dẫn thông thường: **1280×720 hoặc 1920×1080 · 30 FPS · 8–12 Mbps**.
- Chỉ dùng 60 FPS khi thao tác có nhiều chuyển động.
- Muốn thu âm thanh tab/màn hình: khi hộp thoại chia sẻ của Chrome/Edge hiện lên, bật tùy chọn chia sẻ âm thanh nếu nguồn hỗ trợ.

## Riêng tư

Video không được gửi lên backend của Kanrecode. Tất cả việc compositing và MediaRecorder diễn ra trong trình duyệt. Tính năng xóa nền camera tải runtime/model MediaPipe từ CDN của bản upstream; nếu không tải được, các chức năng quay màn hình khác vẫn hoạt động.

## Nguồn và giấy phép

Kanrecode được phát triển từ [SC Screen Recorder](https://github.com/KaliedaRik/sc-screen-recorder) của Rik Roots và tiếp tục tuân thủ giấy phép MIT. Xem `LICENSE` và `THIRD_PARTY_NOTICES.md`.
