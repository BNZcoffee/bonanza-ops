-- ============================================================================
-- [공지 조회자 추적] post_views — 게시글을 연 사람(조회자)과 최초/최근 조회시간 기록
--   게시판(posts/post_reads/comments)과 동일하게 직접 접근(anon) 방식. 민감정보 없음.
--   확인했습니다(post_reads)와는 별개: 이건 '열람(조회)' 수동 추적.
-- ============================================================================
create table if not exists post_views (
  post_id  bigint not null,
  user_id  uuid   not null references users(id) on delete cascade,
  first_at timestamptz not null default now(),   -- 최초 조회시간
  last_at  timestamptz not null default now(),   -- 최근 조회시간
  cnt      int    not null default 1,            -- 조회 횟수
  primary key (post_id, user_id)
);
create index if not exists idx_post_views_post on post_views (post_id, last_at desc);

grant select, insert, update on post_views to anon, authenticated;

-- 완료. 프론트: 공지 열람 시 조회 기록 + [조회자 목록] (작성자/총괄 전용).
