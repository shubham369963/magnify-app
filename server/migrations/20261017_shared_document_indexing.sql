create or replace function public.request_project_index_tree(
    p_project_id uuid,
    p_owner_clerk_id text
) returns bigint language plpgsql security definer
set search_path = '' as $function$
declare requested_generation bigint;
begin
    if not exists (
        select 1 from public.projects where id = p_project_id and owner_clerk_id = p_owner_clerk_id
    ) then raise exception 'Project not found'; end if;
    insert into public.project_index_trees as current_index (
        project_id, owner_clerk_id, generation, status, metadata
    ) values (
        p_project_id, p_owner_clerk_id, 1, 'pending', '{"stage":"loading","percentage":0}'::jsonb
    ) on conflict (project_id) do update
    set generation = current_index.generation + 1, status = 'pending',
        error_message = null, metadata = '{"stage":"loading","percentage":0}'::jsonb, updated_at = now()
    where current_index.owner_clerk_id = excluded.owner_clerk_id
    returning generation into requested_generation;
    if requested_generation is null then raise exception 'Project index ownership mismatch'; end if;
    return requested_generation;
end;
$function$;

-- Merge one prepared document under a row lock so simultaneous upload jobs
-- cannot replace each other's project-tree nodes.
create or replace function public.complete_document_indexing(
    p_project_id uuid,
    p_owner_clerk_id text,
    p_document_id uuid,
    p_document_node jsonb
) returns void language plpgsql security definer
set search_path = '' as $function$
declare
    project_name text;
    current_tree jsonb;
    document_nodes jsonb;
    source_ids jsonb;
    project_status text;
begin
    select name into project_name from public.projects
    where id = p_project_id and owner_clerk_id = p_owner_clerk_id;
    if not found then raise exception 'Project not found'; end if;
    if jsonb_typeof(p_document_node) is distinct from 'object'
        or p_document_node ->> 'type' is distinct from 'document'
        or p_document_node ->> 'document_id' is distinct from p_document_id::text
        or jsonb_typeof(p_document_node -> 'children') is distinct from 'array' then
        raise exception 'Invalid document index node';
    end if;

    insert into public.project_index_trees (project_id, owner_clerk_id)
    values (p_project_id, p_owner_clerk_id) on conflict (project_id) do nothing;
    select tree into current_tree from public.project_index_trees
    where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id for update;
    if not found then raise exception 'Project index ownership mismatch'; end if;

    update public.documents
    set processing_status = 'completed', processing_error = null, updated_at = now()
    where id = p_document_id and project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
    if not found then raise exception 'PDF was removed before indexing completed'; end if;

    select coalesce(jsonb_agg(nodes.node order by d.created_at, d.id), '[]'::jsonb),
        coalesce(jsonb_agg(d.id order by d.created_at, d.id), '[]'::jsonb)
    into document_nodes, source_ids
    from (
        select node from jsonb_array_elements(coalesce(current_tree -> 'children', '[]'::jsonb)) as existing(node)
        where node ->> 'document_id' is distinct from p_document_id::text
        union all select p_document_node
    ) as nodes
    join public.documents d on d.id::text = nodes.node ->> 'document_id'
        and d.project_id = p_project_id and d.owner_clerk_id = p_owner_clerk_id;

    select case
        when bool_or(d.processing_status = 'failed') then 'failed'
        when bool_and(d.processing_status = 'completed' and source_ids ? d.id::text) then 'completed'
        else 'processing'
    end into project_status
    from public.documents d where d.project_id = p_project_id and d.owner_clerk_id = p_owner_clerk_id;

    update public.project_index_trees
    set tree = jsonb_build_object(
            'id', 'project-' || p_project_id::text,
            'type', 'root',
            'title', project_name || ' index',
            'summary', 'Combined index for ' || jsonb_array_length(document_nodes)::text || ' project PDFs.',
            'source_document_ids', source_ids,
            'children', document_nodes
        ),
        generation = generation + 1,
        status = project_status,
        error_message = case when project_status = 'failed' then 'One or more documents failed indexing.' else null end,
        metadata = jsonb_build_object(
            'stage', case when project_status = 'completed' then 'completed' else 'building_tree' end,
            'percentage', case when project_status = 'completed' then 100 else 0 end,
            'document_count', jsonb_array_length(document_nodes)
        ),
        updated_at = now()
    where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
end;
$function$;

create or replace function public.fail_document_indexing(
    p_project_id uuid,
    p_owner_clerk_id text,
    p_document_id uuid,
    p_error_message text
) returns void language plpgsql security definer
set search_path = '' as $function$
begin
    perform 1 from public.project_index_trees
    where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id for update;
    update public.documents
    set processing_status = 'failed', processing_error = left(p_error_message, 1000), updated_at = now()
    where id = p_document_id and project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
    if not found then return; end if;
    update public.project_index_trees
    set status = 'failed', error_message = left(p_error_message, 1000),
        generation = generation + 1, updated_at = now()
    where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
end;
$function$;

-- Remove an upload whose indexing was stopped (for example, provider quota
-- exhaustion) and recompute the project index status from remaining PDFs.
create or replace function public.discard_document_indexing(
    p_project_id uuid,
    p_owner_clerk_id text,
    p_document_id uuid
) returns void language plpgsql security definer
set search_path = '' as $function$
declare
    current_tree jsonb;
    document_nodes jsonb;
    source_ids jsonb;
    project_status text;
begin
    select tree into current_tree from public.project_index_trees
    where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id for update;
    delete from public.documents
    where id = p_document_id and project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
    if not found then return; end if;
    if not exists (
        select 1 from public.documents where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id
    ) then
        delete from public.project_index_trees where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
        return;
    end if;
    if current_tree is null then return; end if;

    select coalesce(jsonb_agg(node), '[]'::jsonb),
        coalesce(jsonb_agg(node -> 'document_id'), '[]'::jsonb)
    into document_nodes, source_ids
    from jsonb_array_elements(coalesce(current_tree -> 'children', '[]'::jsonb)) as existing(node)
    where node ->> 'document_id' is distinct from p_document_id::text;

    select case
        when bool_or(d.processing_status = 'failed') then 'failed'
        when bool_and(d.processing_status = 'completed' and source_ids ? d.id::text) then 'completed'
        else 'processing'
    end into project_status
    from public.documents d where d.project_id = p_project_id and d.owner_clerk_id = p_owner_clerk_id;

    update public.project_index_trees
    set tree = jsonb_set(jsonb_set(current_tree, '{children}', document_nodes), '{source_document_ids}', source_ids),
        generation = generation + 1,
        status = project_status,
        error_message = case when project_status = 'failed' then 'One or more documents failed indexing.' else null end,
        metadata = jsonb_build_object(
            'stage', case when project_status = 'completed' then 'completed' else 'building_tree' end,
            'percentage', case when project_status = 'completed' then 100 else 0 end,
            'document_count', jsonb_array_length(document_nodes)
        ),
        updated_at = now()
    where project_id = p_project_id and owner_clerk_id = p_owner_clerk_id;
end;
$function$;

revoke all on function public.complete_document_indexing(uuid, text, uuid, jsonb) from public;
revoke all on function public.fail_document_indexing(uuid, text, uuid, text) from public;
revoke all on function public.request_project_index_tree(uuid, text) from public;
revoke all on function public.discard_document_indexing(uuid, text, uuid) from public;
grant execute on function public.complete_document_indexing(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.fail_document_indexing(uuid, text, uuid, text) to service_role;
grant execute on function public.request_project_index_tree(uuid, text) to service_role;
grant execute on function public.discard_document_indexing(uuid, text, uuid) to service_role;
