create table lists (
  id text primary key,
  owner_profile text not null,
  name text not null,
  about text not null default '',
  visibility text not null check (visibility in ('public', 'private')),
  kind text not null check (kind in ('standard', 'tagged')),
  allow_arbor_user_edits boolean not null default false,
  created_at text not null,
  updated_at text not null
);

create table practices (
  id text primary key,
  name text not null unique,
  about text not null default '',
  created_at text not null,
  updated_at text not null
);

create table practice_authors (
  practice_id text not null references practices(id),
  author_profile text not null,
  primary key (practice_id, author_profile)
);

create table list_practices (
  list_id text not null references lists(id),
  practice_id text not null references practices(id),
  position integer not null,
  primary key (list_id, practice_id),
  unique (list_id, position)
);

create table list_reactions (
  list_id text not null references lists(id),
  profile text not null,
  emoji text not null,
  primary key (list_id, profile)
);

create table list_tags (
  list_id text not null references lists(id),
  id text not null,
  name text not null,
  color text,
  primary key (list_id, id)
);

create table practice_tags (
  list_id text not null,
  practice_id text not null,
  tag_id text not null,
  primary key (list_id, practice_id, tag_id),
  foreign key (list_id, practice_id) references list_practices(list_id, practice_id),
  foreign key (list_id, tag_id) references list_tags(list_id, id)
);

create table list_contributors (
  list_id text not null references lists(id),
  profile text not null,
  first_contributed_at text not null,
  last_contributed_at text not null,
  primary key (list_id, profile)
);

create index lists_by_owner_updated on lists(owner_profile, updated_at desc, id);
create index practice_authors_by_author on practice_authors(author_profile, practice_id);
create index list_practices_by_practice on list_practices(practice_id, list_id);
