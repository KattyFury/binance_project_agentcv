# agentCV: brief để bàn lại hướng sản phẩm

Cập nhật 2026-11-22. Viết để dán vào một cuộc chat khác và thảo luận lại sản phẩm này là gì, có đáng làm tiếp không, nên đổi hướng ra sao.

## 1. Bối cảnh

- Cuộc thi: **Agent ID Hackathon** (Binance Wallet x BNB Chain). Hạn nộp 2026-12-09 08:00 UTC, dự định nộp sớm ngày 07/12.
- Giải nhắm tới: **Innovation**. Điều kiện bắt buộc là ít nhất 30 địa chỉ Agent ID khác nhau tương tác với contract. Mục tiêu là hơn 100. Có thử thêm giải Pioneer. Mỗi dự án chỉ nhận 1 giải.
- **Agent ID** là NFT (ERC-721, contract `0x60b9…022f` trên BNB Chain) mà người dùng Binance nhận được để định danh AI agent của mình. Agent chạy trong Binance AI Pro / Agentic Wallet và tự ký giao dịch (cần bật Developer Mode).
- Vạch đỏ của BTC (vi phạm là bị loại):
  - không đăng nhập web bằng QR;
  - không né bước người dùng xác nhận giao dịch;
  - không giữ hay thu tiền của người dùng;
  - mã nguồn mở;
  - không hứa lợi nhuận;
  - có cảnh báo rủi ro;
  - mỗi người 1 Agent ID;
  - không tạo nhiều ví để bơm số.

## 2. Sản phẩm hiện tại, nói 1 câu

**Bảng xếp hạng AI agent dựa trên khả năng dự đoán giá crypto**: agent đoán xác suất BTC/ETH/BNB tăng trong giờ tới, được chấm điểm on-chain, và tích luỹ thành một "CV" công khai không sửa được.

## 3. Cách chơi

1. Người dùng dán một prompt vào AI của họ (Binance AI Pro có skill Agentic Wallet).
2. Mỗi giờ, agent đọc API của mình để biết vòng nào đang mở, rồi đưa ra **xác suất giá tăng** (1–99%) cho BTC, ETH, BNB.
3. Agent hỏi người dùng, người dùng duyệt, agent ký (EIP-712). Relayer của dự án gửi giao dịch và trả gas, nên người chơi không tốn phí.
4. Đầu mỗi giờ, keeper ghi giá Chainlink lên chain. Hết vòng thì chấm điểm:
   `điểm = 0,25 − (xác suất − kết quả)²`.
   - Đoán 50% được 0 điểm.
   - Đoán chắc mà đúng được tối đa +0,25.
   - Đoán chắc mà sai bị trừ tối đa −0,73.
5. Bảng tuần xếp theo tổng điểm, cần ít nhất 10 dự đoán đã chấm mới được lên bảng. Top 10 nhận quà nhỏ (khoảng $10 BNB/tuần), đội tự trả bằng tay, nằm ngoài contract.
6. Phụ: agent đăng báo cáo nghiên cứu (lưu hash on-chain), agent khác chấm 1–5 sao. Có contract `ReputationGate` mẫu để dApp khác cho vào cửa theo điểm uy tín.

Không cược tiền, không nạp tiền, contract không giữ tài sản của ai.

## 4. Đã build và đang chạy (mainnet, bản thử)

| Phần | Trạng thái |
|---|---|
| Contracts: PredictArena, ReportRegistry, ReputationHub, ReputationGate | Đã deploy bản thử trên BNB Chain mainnet. 29 test qua. Chưa verify trên BscScan (đang chờ API key). |
| Keeper (Cloudflare Worker, chạy mỗi 5 phút) | Đang tự ghi giá mỗi giờ. Gas khoảng 0,000012 BNB mỗi lần. |
| Relayer + API | Đang chạy. Agent ký, bot gửi lên chain. |
| Web 5 trang: Leaderboard, Rounds, Agent CV, Reports, Join | Live tại https://agentcv.kattyfury1403.workers.dev |
| Test thật | Agent của chủ dự án chạy trên Binance AI Pro đã ký và gửi thành công 18 dự đoán (tx `0x0031…2616`). |

Đã sửa sau lần test thật: lúc đầu cho đặt trước 6 giờ, nên agent đặt một lèo 18 dự đoán toàn 49–51%. Vô nghĩa. Giờ chỉ mở **vòng 1 giờ kế tiếp** (cộng vòng 24 giờ, ngày một lần), mỗi gói tối đa 6 dự đoán.

## 5. Điểm yếu (thẳng thắn)

1. **Nhạt, không có lý do để quay lại.** Người dùng nhìn thấy một bảng số. Không có câu chuyện, không có gì để khoe hay tranh luận.
2. **Ma sát rất cao.** Người chơi phải nhắn AI mỗi giờ và duyệt từng lần ký. Nếu AI Pro không hẹn giờ chạy tự động được thì gần như không ai chơi đều.
3. **Agent hay đoán 50% cho an toàn.** Khi đó điểm ≈ 0 và bảng xếp hạng toàn số 0.
4. **"Đoán giá crypto từng giờ" phần lớn là nhiễu.** Điểm cao có thể chỉ là may, chứ không chứng minh agent giỏi. Một "CV" dựa trên đó yếu về mặt ý nghĩa.
5. **Khó đạt 30–100 Agent ID** nếu bản thân việc chơi đã chán và phiền.
6. Người dùng (chủ dự án) không hiểu agent đang nói gì: luồng quá kỹ thuật (nonce, EIP-712, relayer).

## 6. Câu hỏi cần chốt

1. Mục đích thật sự là gì: **thắng giải** (chỉ cần hơn 30 Agent ID tương tác và một demo đẹp), hay **một sản phẩm người ta muốn dùng**?
2. "Uy tín của agent" nên đo bằng gì để có ý nghĩa, nếu không phải đoán giá từng giờ? Ví dụ: dự đoán sự kiện dài hơn, chất lượng nghiên cứu, việc thật agent đã làm, đánh giá chéo…
3. Làm sao cho người chơi chỉ phải thao tác **một lần** (hoặc ít nhất có thể), mà không vi phạm luật "người dùng phải xác nhận giao dịch"?
4. Cái gì khiến người chơi rủ người khác vào chơi: so tài với agent của bạn bè, có thứ để khoe, tranh luận về lý do agent đưa ra?
5. Giữ phần nào trong cái đã build (contract, keeper, relayer, web), bỏ phần nào?
6. Còn khoảng 2 tuần. Nếu đổi hướng thì mốc nào phải xong trước?

## 7. Hạ tầng có thể tái dùng dù đổi hướng

- Relayer ký EIP-712 và trả gas hộ agent (đã chạy với Binance AI Pro thật).
- Kiểm tra có Agent ID (`balanceOf > 0`) để chặn người ngoài.
- Keeper đọc giá Chainlink theo giờ.
- Web đọc dữ liệu on-chain theo design system có sẵn.
- Repo: https://github.com/KattyFury/binance_project_agentcv
