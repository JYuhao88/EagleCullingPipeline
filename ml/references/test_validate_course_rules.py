import copy
import json
import tempfile
import unittest
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
import validate_course_rules
from pathlib import Path
from validate_course_rules import validate, load_manifests


class ClaimsTests(unittest.TestCase):
    def setUp(self):
        self.manifests=[{'source':'s','videos':[{'course':'a','episode':1,'duration_seconds':100,'count_only':False},
                                               {'course':'a','episode':2,'duration_seconds':100,'count_only':False}]}]
        self.item={'ruleId':'P-ONE','kind':'source','courseSlug':'s','paraphrase':'手指放松',
                   'locator':{'source':'s','episode':1,'start':10,'end':20}}
        self.evidence={'contractVersion':1,'courses':[{'slug':'s','source':'s'}],'evidence':[self.item]}
        self.candidates={'contractVersion':1,'rules':[]}

    def check(self):return validate(self.evidence,self.candidates,{'P-ONE'},self.manifests)

    def test_real_support_count_distinct_episodes(self):
        self.item['supports']=[{'locator':{'source':'s','episode':2,'start':30,'end':40}}]
        self.item['supportCount']=2
        self.assertEqual(self.check()['evidence'],1)
        self.item['supports']=[{'locator':{'source':'s','episode':1,'start':30,'end':40}}]
        with self.assertRaisesRegex(ValueError,'supportCount'):self.check()

    def test_reject_unlocated_or_long_claims(self):
        for change in ({'paraphrase':'字'*41},{'ruleId':'UNKNOWN'},{'kind':'opinion'}):
            saved=copy.deepcopy(self.item);self.item.update(change)
            with self.assertRaises(ValueError):self.check()
            self.item.clear();self.item.update(saved)
        self.item['locator']['end']=1010
        with self.assertRaises(ValueError):self.check()

    def test_count_only_and_ambiguous_episode_refused(self):
        self.manifests[0]['videos'][0]['count_only']=True
        with self.assertRaisesRegex(ValueError,'count-only'):self.check()
        self.manifests[0]['videos'][0]['count_only']=False
        self.manifests[0]['videos'].append({'course':'b','episode':1,'duration_seconds':100,'count_only':False})
        with self.assertRaisesRegex(ValueError,'ambiguous'):self.check()
        self.item['locator']['course']='a'
        self.assertEqual(self.check()['evidence'],1)

    def test_candidate_never_promotes_to_gate(self):
        self.candidates['rules']=[{'id':'P-NEW','status':'proposed','source':'course:s','severity':'gate',
                                   'evidence':[{**self.item,'ruleId':'P-NEW'}]}]
        with self.assertRaisesRegex(ValueError,'severity'):self.check()
        self.candidates['rules'][0]['severity']='hint'
        self.assertEqual(self.check()['candidates'],1)
        self.candidates['rules'][0]['evidence']*=5
        with self.assertRaisesRegex(ValueError,'1..4'):self.check()

    def test_stable_episode_id_matches_locator(self):
        self.manifests[0]['videos'][0]['bvid']='s-first'
        self.item['locator']['episodeId']='s-second'
        with self.assertRaisesRegex(ValueError,'episodeId'):self.check()
        self.item['locator']['episodeId']='s-first'
        self.assertEqual(self.check()['evidence'],1)

    def test_pdf_page_matches_document_without_time_range(self):
        self.manifests[0]['videos'].append({'course':'a','episode':1,'bvid':'workbook',
                                           'pages':10,'count_only':False})
        # A subtitle and workbook can share an episode number.
        self.assertEqual(self.check()['evidence'],1)
        self.item['locator']={'source':'s','course':'a','episode':1,'episodeId':'workbook','page':3}
        self.assertEqual(self.check()['evidence'],1)
        for page in (0,11,True,2.5,'3',None):
            self.item['locator']['page']=page
            with self.assertRaisesRegex(ValueError,'page'):self.check()
        self.item['locator']['page']=3
        self.item['locator']['start']=0
        with self.assertRaisesRegex(ValueError,'time range'):self.check()

    def test_workbooks_with_same_episode_count_distinct_documents(self):
        self.manifests[0]['videos']=[{'course':'a','episode':0,'bvid':bvid,'pages':10,'count_only':False}
                                   for bvid in ('workbook-a','workbook-b')]
        self.item['locator']={'source':'s','course':'a','episode':0,'episodeId':'workbook-a','page':3}
        self.item['supports']=[{'locator':{**self.item['locator'],'page':5}}]
        self.assertEqual(self.check()['evidence'],1)
        self.item['supports'][0]['locator']['episodeId']='workbook-b'
        self.item['supportCount']=2
        self.assertEqual(self.check()['evidence'],1)
        del self.item['locator']['episodeId']
        with self.assertRaisesRegex(ValueError,'ambiguous'):self.check()

    def test_load_additional_materials_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            legacy=root/'hanjing-manifest.json'
            materials=root/'materials-course-texts-manifest.json'
            legacy.write_text(json.dumps({'source':'hanjing','videos':[]}))
            materials.write_text(json.dumps({'source':'materials-course-texts','videos':[]}))
            manifests=load_manifests(root,[materials])
            sources=[manifest['source'] for manifest in manifests]
            self.assertIn('hanjing',sources)
            # The optional /tmp manifest may exist in an active processing run.
            self.assertEqual(sources.count('hanjing'),1)
            self.assertIn('materials-course-texts',sources)


class ManifestLoadingTests(unittest.TestCase):
    def test_meyerowitz_durable_manifest_after_private_text_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);data=root/'private';data.mkdir()
            doc={'source':'materials-courses-meyerowitz','videos':[]}
            (root/'meyerowitz_processing_manifest.json').write_text(json.dumps(doc))
            with patch.object(validate_course_rules,'__file__',str(root/'validator.py')):
                loaded=validate_course_rules.load_manifests(data)
            self.assertIn(doc,loaded)

    def test_canonical_manifests_exclude_upload_and_partial_job_snapshots(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);data=root/'data';data.mkdir()
            doc={'source':'synthetic','videos':[{'episode':1}]}
            (data/'synthetic-manifest.json').write_text(json.dumps(doc))
            (data/'job-asr-manifest.json').write_text(json.dumps(doc))
            (data/'upload-manifest.json').write_text(json.dumps({'files':[]}))
            (root/'portrait_courses_processing_manifest.json').write_text(json.dumps({'courses':[doc,{'source':'fallback','videos':[]}]}))
            with patch.object(validate_course_rules,'__file__',str(root/'validator.py')):
                loaded=validate_course_rules.load_manifests(data)
            self.assertEqual(sum(m['source']=='synthetic' for m in loaded),1)
            self.assertEqual(sum(m['source']=='fallback' for m in loaded),1)



if __name__=='__main__':unittest.main()
