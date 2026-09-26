# Kanrecode

**Kanrecode V1.4** là ứng dụng quay màn hình chạy local, tối ưu cho video hướng dẫn desktop. Giao diện dùng tone xanh lá pastel, thao tác theo hướng ít bước và video không được tải lên backend của Kanrecode.

## V1.4 có gì mới

### 1. Công cụ làm video hướng dẫn
- Đếm ngược: Tắt / 3 giây / 5 giây.
- Highlight vị trí click.
- Hiện phím bấm: **mặc định tắt**, bật/tắt bằng checkbox hoặc `Ctrl+Shift+K`.
- Vì lý do riêng tư, Desktop Helper **không chuyển tiếp chữ/số gõ đơn lẻ**. Nó chỉ chuyển phím chức năng, phím điều hướng và tổ hợp có Ctrl/Alt/Win.
- Spotlight con trỏ.
- Bút chú thích vẫn có thể bật/tắt bằng `Ctrl+Shift+D`.
- Tooltip khi hover hiển thị công dụng và phím tắt.
- Cảnh báo khi chọn tab trình duyệt để tránh quay chính Kanrecode gây hiệu ứng gương lặp.

### 2. Quay video dài không ngốn RAM
Khi chạy bằng `START_KANRECODE.bat`, Desktop Helper mở local server và Kanrecode có thể ghi từng chunk trực tiếp xuống:

`%USERPROFILE%\Videos\Kanrecode`

Trong lúc đang ghi, tệp có dạng `.partial.webm` hoặc `.partial.mp4`. Khi dừng đúng cách, Helper đổi thành tệp video cuối cùng.

Nếu ứng dụng/máy bị ngắt đột ngột, tệp `.partial` được giữ lại và Kanrecode sẽ báo ở lần mở sau. WebM thường có khả năng cứu dữ liệu tốt hơn MP4 nếu phiên bị cắt ngang.

Nếu Desktop Helper không chạy, Kanrecode tự quay theo chế độ trình duyệt cũ và giữ các chunk trong RAM cho tới khi tải tệp xuống.

### 3. Chọn vùng quay
- Bấm **Chọn vùng** hoặc `Ctrl+Shift+R`.
- Kéo chuột để khoanh vùng.
- Có **8 điểm resize**.
- Có thể kéo cả khung để di chuyển.
- Kích thước pixel được hiển thị trực tiếp.
- Bấm **Áp dụng** hoặc **Esc** để hủy.
- Output canvas vẫn giữ nguyên độ phân giải; chỉ vùng nguồn được crop.

### 4. Auto Zoom
Ba chế độ:
- **Tắt**
- **Zoom khi click**
- **Thủ công**

Mức zoom mặc định 1.35× và có thanh kéo 1.15×–1.75×.

Auto Zoom, click highlight và spotlight có thể nhận chuột toàn Windows khi Desktop Helper đang chạy. Tính năng này chính xác nhất khi quay **toàn màn hình trên một màn hình chính**; cấu hình nhiều monitor hoặc chỉ quay một cửa sổ có thể cần căn chỉnh thêm.

## Phím tắt

- `F9`: bắt đầu / dừng quay khi đang ở Kanrecode.
- `F10`: pause / resume khi đang ở Kanrecode.
- `Ctrl+Shift+F9`: bắt đầu / dừng quay toàn Windows khi Desktop Helper chạy.
- `Ctrl+Shift+F10`: pause / resume toàn Windows.
- `Ctrl+Shift+K`: bật / tắt hiển thị phím.
- `Ctrl+Shift+D`: bật / tắt bút chú thích.
- `Ctrl+Shift+R`: chọn vùng quay.
- `Ctrl+Shift+J`: bật / tắt zoom thủ công.
- `Ctrl+Shift+H`: bật / tắt highlight click.
- `Ctrl+Shift+L`: bật / tắt spotlight.
- `Alt+Z / Alt+Y / Alt+X`: hoàn tác / làm lại / xóa nét vẽ.

## Các chức năng nền vẫn giữ nguyên

- Nhiều nguồn: tab, cửa sổ hoặc toàn màn hình.
- Kéo, phóng to/thu nhỏ, xoay, opacity và layer.
- Quay không cần microphone.
- Trộn microphone với audio tab/màn hình nếu nguồn chia sẻ cung cấp audio track.
- 25 / 30 / 60 FPS.
- Bitrate 4 / 8 / 12 / 20 Mbps.
- MP4 khi browser hỗ trợ; fallback WebM.
- Camera talking-head, xóa nền MediaPipe và filter.
- Teleprompter + TXT / SRT / VTT.
- Background và logo tùy chọn.

## Chạy khuyên dùng trên Windows

1. Clone/tải repo.
2. Nhấp đúp `START_KANRECODE.bat`.
3. Giữ cửa sổ **KANRECODE DESKTOP HELPER** chạy trong thời gian sử dụng.
4. Trình duyệt tự mở `http://127.0.0.1:8765`.

Desktop Helper chỉ bind vào `127.0.0.1`, không mở dịch vụ ra mạng LAN.

Nếu chỉ chạy bằng web server tĩnh/GitHub Pages, chức năng quay cơ bản vẫn hoạt động nhưng:
- không ghi chunk thẳng xuống thư mục Videos;
- không nhận click/phím toàn Windows;
- các hiệu ứng bàn phím/chuột chỉ nhận được khi Kanrecode có focus.

## Gợi ý cấu hình

Video hướng dẫn thông thường:
- 1920×1080
- 30 FPS
- 8–12 Mbps
- Countdown 3 giây
- Click highlight: ON
- Hiện phím: tùy nhu cầu
- Auto Zoom: Click
- Spotlight: OFF

## Kiểm tra chất lượng source

Repo có GitHub Actions tại `.github/workflows/validate.yml`, kiểm tra:
- cú pháp Python Desktop Helper;
- cú pháp JavaScript;
- ID HTML bị trùng;
- các `getElementById` trỏ tới phần tử không tồn tại;
- các thư viện bắt buộc.

## Riêng tư

- Kanrecode không tải video lên backend.
- Desktop Helper không ghi lịch sử bàn phím ra tệp.
- Chữ/số gõ đơn lẻ không được đưa sang trình duyệt bởi Helper.
- Sự kiện chuột/phím phục vụ hiệu ứng chỉ nằm trong bộ nhớ và buffer ngắn khi Helper chạy.

## Nguồn và giấy phép

Kanrecode được phát triển từ [SC Screen Recorder](https://github.com/KaliedaRik/sc-screen-recorder) của Rik Roots và tiếp tục tuân thủ giấy phép MIT. Xem `LICENSE` và `THIRD_PARTY_NOTICES.md`.
