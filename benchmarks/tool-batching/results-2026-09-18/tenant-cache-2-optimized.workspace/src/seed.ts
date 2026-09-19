import type { Seed } from './db/database.ts';
export function sampleSeed():Seed {return {
  users:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'},{id:'both',name:'Both'}],
  organizations:[{id:'org-a',name:'A'},{id:'org-b',name:'B'}],
  memberships:[{userId:'alice',organizationId:'org-a'},{userId:'bob',organizationId:'org-b'},{userId:'both',organizationId:'org-a'},{userId:'both',organizationId:'org-b'}],
  sessions:{alice:'alice',bob:'bob',both:'both'},
  projects:[{id:'a1',organizationId:'org-a',name:'Alpha',updatedAt:3},{id:'a2',organizationId:'org-a',name:'Delta',updatedAt:1},{id:'a3',organizationId:'org-a',name:'Gamma',updatedAt:2},{id:'b1',organizationId:'org-b',name:'Beta',updatedAt:7},{id:'b2',organizationId:'org-b',name:'Echo',updatedAt:5},{id:'b3',organizationId:'org-b',name:'Foxtrot',updatedAt:6}],
};}
